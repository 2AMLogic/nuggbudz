#!/usr/bin/env node
/**
 * End-to-end pairing smoke test against a running dev server.
 *
 * Vitest covers the pure settlement, geo and matchmaking logic. This drives the
 * real Worker and Durable Object over real WebSockets, because the thing most
 * worth protecting — two strangers landing on the same match with the same
 * split — only exists once those pieces are wired together.
 *
 * The pool socket now requires a session, so this script seeds sessions straight
 * into the local KV namespace rather than driving a real Google sign-in: there
 * is no way to complete an OAuth round trip unattended, and faking one would
 * mean weakening the Worker with a test-only login route.
 *
 * Usage:  pnpm dev --port 5199     (in one shell)
 *         pnpm smoke               (in another)
 *
 * `BASE` overrides the target, e.g. BASE=http://localhost:5211 pnpm smoke.
 *
 * The expiry checks only run when the dev server is configured with short
 * liveness windows — nobody waits 15 real minutes for a smoke test. To include
 * them, put this in `.dev.vars` before starting the dev server:
 *
 *   QUEUE_IDLE_SECONDS="6"
 *   QUEUE_WARN_LEAD_SECONDS="3"
 *   MATCH_CONFIRM_SECONDS="8"
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_COORDS } from './smoke-fixtures.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5199'
const WS = BASE.replace('http', 'ws')

const log = (...a) => console.log(...a)
let failures = 0
const check = (name, ok, extra = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

/**
 * Session ids are opaque 43-character base64url strings. These are fixed rather
 * than random so a re-run overwrites the same keys instead of piling up.
 */
const sessionId = (label) => label.padEnd(43, '0').slice(0, 43)

/**
 * A seeded account id, shaped like a real one.
 *
 * `users.id` is a `crypto.randomUUID()`, and the ledger books money only against
 * an id that could have come out of a sign-in — anything else is refused rather
 * than booked (`shared/identity.ts`). So these fixtures are UUIDs rather than
 * readable labels; the buyer's name is what the output shows anyway. Numbered
 * rather than random so a re-run seeds the same ids as the last one.
 */
const accountId = (n) => `5eed5eed-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  robb: { sid: sessionId('smoke-robb'), userId: accountId(1), name: 'Robb' },
  dana: { sid: sessionId('smoke-dana'), userId: accountId(2), name: 'Dana' },
  far: { sid: sessionId('smoke-faraway'), userId: accountId(3), name: 'Faraway' },
  bad: { sid: sessionId('smoke-bad'), userId: accountId(4), name: 'Bad' },
  // Same cell, too far apart to pair, purely to prove the cell-wide roster
  // broadcast without either of them ever actually pairing up.
  kim: { sid: sessionId('smoke-kim'), userId: accountId(5), name: 'Kim' },
  lee: { sid: sessionId('smoke-lee'), userId: accountId(6), name: 'Lee' },
  // Signed in only to be signed out again.
  doomed: { sid: sessionId('smoke-doomed'), userId: accountId(7), name: 'Doomed' },
  // The pickup handshake pair, and the pair that never finishes one.
  gus: { sid: sessionId('smoke-gus'), userId: accountId(8), name: 'Gus' },
  hana: { sid: sessionId('smoke-hana'), userId: accountId(9), name: 'Hana' },
  ivy: { sid: sessionId('smoke-ivy'), userId: accountId(10), name: 'Ivy' },
  jed: { sid: sessionId('smoke-jed'), userId: accountId(11), name: 'Jed' },
  // The pair that never sends a coordinate: the promptless path.
  kai: { sid: sessionId('smoke-kai'), userId: accountId(12), name: 'Kai' },
  lex: { sid: sessionId('smoke-lex'), userId: accountId(13), name: 'Lex' },
  // Liveness: one buyer who keeps pinging, one who goes quiet, and a pair who
  // match and then never confirm.
  pinger: { sid: sessionId('smoke-pinger'), userId: accountId(14), name: 'Pinger' },
  stale: { sid: sessionId('smoke-stale'), userId: accountId(15), name: 'Stale' },
  slowOne: { sid: sessionId('smoke-slow-one'), userId: accountId(16), name: 'Slow One' },
  slowTwo: { sid: sessionId('smoke-slow-two'), userId: accountId(17), name: 'Slow Two' },
  // A pair where exactly one side confirms: the expiry sweep must leave them to
  // the dispute path.
  halfOne: { sid: sessionId('smoke-half-one'), userId: accountId(18), name: 'Half One' },
  halfTwo: { sid: sessionId('smoke-half-two'), userId: accountId(19), name: 'Half Two' },
  // The sauce pair: one who tries ids that are not on the menu, and the buddy
  // who has to be told what the other actually wants at the counter.
  sal: { sid: sessionId('smoke-sal'), userId: accountId(20), name: 'Sal' },
  nia: { sid: sessionId('smoke-nia'), userId: accountId(21), name: 'Nia' },
  // The same account signing in again, which is how a stored preference is asked
  // to survive a sign-out: a different session id, the same user behind it.
  robbAgain: { sid: sessionId('smoke-robb-again'), userId: accountId(1), name: 'Robb' },
}

/** Write the sessions into the dev server's KV namespace, in one CLI call. */
function seedSessions() {
  const entries = Object.values(BUYERS).map((buyer) => ({
    key: `session:${buyer.sid}`,
    value: JSON.stringify({
      userId: buyer.userId,
      googleSub: `smoke-sub-${buyer.userId}`,
      displayName: buyer.name,
      email: null,
      avatarUrl: null,
      createdAt: Date.now(),
    }),
  }))
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-smoke-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  try {
    execFileSync(
      'npx',
      ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'],
      // The dev server's local KV is the same store wrangler writes to, so this
      // lands live in the running server.
      { stdio: 'pipe', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } },
    )
  } catch (error) {
    log('FAIL  could not seed sessions into local KV')
    log(String(error.stderr ?? error))
    process.exit(1)
  }
}

const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

/** The ledger tables have to exist before a settled split can be booked. */
function applyMigrations() {
  try {
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
      stdio: 'pipe',
      env: WRANGLER_ENV,
    })
  } catch (error) {
    log('FAIL  could not apply migrations to the local D1')
    log(String(error.stderr ?? error))
    process.exit(1)
  }
}

/** Read the ledger the dev server writes to — the same local D1 wrangler sees. */
function ledgerQuery(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'nuggbudz', '--local', '--json', '--command', sql],
    { stdio: ['ignore', 'pipe', 'pipe'], env: WRANGLER_ENV },
  )
  return JSON.parse(out.toString())[0]?.results ?? []
}

/**
 * Give the seeded sessions the `users` rows a real sign-in would have left behind.
 *
 * `user_sauces` hangs off `users` by foreign key, so a preference written for a
 * session with no account behind it is refused — correctly. Seeding the accounts
 * is what makes these fixtures resemble signed-in buyers rather than weakening
 * the schema to accommodate a test.
 */
function seedUsers() {
  const now = Date.now()
  const seen = new Set()
  const rows = []
  for (const buyer of Object.values(BUYERS)) {
    if (seen.has(buyer.userId)) continue
    seen.add(buyer.userId)
    rows.push(
      `('${buyer.userId}', 'smoke-sub-${buyer.userId}', NULL, '${buyer.name}', NULL, ${now}, ${now})`,
    )
  }
  ledgerQuery(
    `INSERT OR IGNORE INTO users
       (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES ${rows.join(', ')}`,
  )
}

seedSessions()
applyMigrations()
seedUsers()
const cookie = (buyer) => ({ Cookie: `nb_session=${buyer.sid}` })

// --- REST surface ---
const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
check('health ok', health.ok === true, JSON.stringify(health))

const { deals } = await fetch(`${BASE}/api/deals`).then((r) => r.json())
check(
  'deals catalogue returned (McDonald-only)',
  Array.isArray(deals) && deals.length === 1,
  `${deals?.length} deals`,
)
const mcd = deals.find((d) => d.id === 'mcd-nuggets-20')
check(
  'mcd half is $4.49',
  mcd.settlement.shares[1].payCents === 449,
  `${mcd.settlement.shares[1].payCents}`,
)
check('mcd spread is $5.99', mcd.spread.grossSpreadCents === 599, `${mcd.spread.grossSpreadCents}`)

const quote = await fetch(`${BASE}/api/deals/mcd-nuggets-20/quote?partySize=4`).then((r) =>
  r.json(),
)
check(
  'party of 4 splits 20pc evenly',
  quote.settlement.shares.every((s) => s.piecesOwed === 5),
)
const bad = await fetch(`${BASE}/api/deals/mcd-nuggets-20/quote?partySize=1`)
check('party of 1 rejected', bad.status === 400, `status ${bad.status}`)
const missing = await fetch(`${BASE}/api/deals/nope/quote`)
check('unknown deal 404s', missing.status === 404, `status ${missing.status}`)
// A gated deal is the harder case: it *is* in the catalogue, so `findDeal`
// resolves it. Quoting a price for a chain the app will not pair you on is a
// dead end, so it has to 404 like a deal that does not exist at all.
const gatedQuotes = await Promise.all(
  ['wendys-nuggets-20', 'bk-nuggets-20'].map((id) => fetch(`${BASE}/api/deals/${id}/quote`)),
)
check(
  'a gated deal is not quotable',
  gatedQuotes.every((r) => r.status === 404),
  gatedQuotes.map((r) => r.status).join('/'),
)

// --- sauce preferences ---
const jsonHeaders = { 'content-type': 'application/json' }
const putSauces = (buyer, sauces) =>
  fetch(`${BASE}/api/me/sauces`, {
    method: 'PUT',
    headers: buyer === null ? jsonHeaders : { ...jsonHeaders, ...cookie(buyer) },
    body: JSON.stringify({ sauces }),
  })

const anonReadSauces = await fetch(`${BASE}/api/me/sauces`)
check(
  'a sauce preference is nobody’s business but its owner’s',
  anonReadSauces.status === 401,
  `status ${anonReadSauces.status}`,
)
const anonWriteSauces = await putSauces(null, ['mcd-ketchup', 'mcd-ketchup'])
check(
  'an unauthenticated write is refused',
  anonWriteSauces.status === 401,
  `status ${anonWriteSauces.status}`,
)

const storedSauces = await putSauces(BUYERS.robb, ['mcd-ketchup', 'mcd-hot-mustard'])
const storedBody = await storedSauces.json()
check(
  'a pair is stored and answered in catalogue order',
  storedSauces.status === 200 &&
    storedBody.sauces?.[0] === 'mcd-hot-mustard' &&
    storedBody.sauces?.[1] === 'mcd-ketchup',
  JSON.stringify(storedBody),
)

// The whole point of storing it on the account: a new session for the same buyer
// — which is what signing back in produces — reads the pair back.
const afterSignIn = await fetch(`${BASE}/api/me/sauces`, { headers: cookie(BUYERS.robbAgain) })
const afterSignInBody = await afterSignIn.json()
check(
  'the pair survives a sign-out and a sign-in',
  afterSignIn.status === 200 && afterSignInBody.sauces?.join() === 'mcd-hot-mustard,mcd-ketchup',
  JSON.stringify(afterSignInBody),
)

// An id off a query string or a JSON body is hostile: refused, and not repeated
// back in the answer.
const hostileSauce = 'mcd-not-a-sauce"><script>alert(1)</script>'
const refusedSauce = await putSauces(BUYERS.robb, ['mcd-ketchup', hostileSauce])
const refusedText = await refusedSauce.text()
check(
  'an unknown sauce id is refused',
  refusedSauce.status === 400,
  `status ${refusedSauce.status}`,
)
check(
  'the refusal does not echo the id back',
  !refusedText.includes('not-a-sauce') && !refusedText.includes('<script>'),
  refusedText,
)
// A real sauce belonging to a chain the app does not pair on. It resolves in the
// catalogue, which is exactly why it has to be refused here.
const gatedSauce = await putSauces(BUYERS.robb, ['bk-zesty', 'bk-zesty'])
check(
  'a gated chain’s sauce is not selectable',
  gatedSauce.status === 400,
  `status ${gatedSauce.status}`,
)
const unchanged = await fetch(`${BASE}/api/me/sauces`, { headers: cookie(BUYERS.robb) })
const unchangedBody = await unchanged.json()
check(
  'a refused write changes nothing',
  unchangedBody.sauces?.join() === 'mcd-hot-mustard,mcd-ketchup',
  JSON.stringify(unchangedBody),
)
const noPairYet = await fetch(`${BASE}/api/me/sauces`, { headers: cookie(BUYERS.nia) })
const noPairYetBody = await noPairYet.json()
check(
  'a buyer who never picked has no pair, not an error',
  noPairYet.status === 200 && noPairYetBody.sauces === null,
  JSON.stringify(noPairYetBody),
)

// --- sessions ---
const anonMe = await fetch(`${BASE}/api/auth/me`)
check('anonymous /auth/me is 401', anonMe.status === 401, `status ${anonMe.status}`)

const signedInMe = await fetch(`${BASE}/api/auth/me`, { headers: cookie(BUYERS.robb) })
const meBody = await signedInMe.json()
check(
  'seeded session resolves to its user',
  signedInMe.status === 200 && meBody.user?.displayName === 'Robb',
  JSON.stringify(meBody),
)

const forgedMe = await fetch(`${BASE}/api/auth/me`, {
  headers: { Cookie: `nb_session=${sessionId('not-a-real-session')}` },
})
check('a forged session id is not a session', forgedMe.status === 401, `status ${forgedMe.status}`)

// An unauthenticated upgrade must be refused before any socket exists.
const anonUpgrade = await fetch(`${BASE}/api/pool/ws?lat=37.7955&lng=-122.3937`)
check('unauthenticated pool upgrade is 401', anonUpgrade.status === 401, `${anonUpgrade.status}`)

const anonSocketOpened = await new Promise((resolve) => {
  const ws = new WebSocket(`${WS}/api/pool/ws?lat=37.7955&lng=-122.3937`)
  ws.addEventListener('open', () => {
    ws.close()
    resolve(true)
  })
  ws.addEventListener('error', () => resolve(false))
  setTimeout(() => resolve(false), 4000)
})
check('unauthenticated websocket never opens', anonSocketOpened === false)

// Sign-in start and callback answer honestly whether or not Google is configured
// in this environment, and in particular never 500.
const start = await fetch(`${BASE}/api/auth/google/start`, { redirect: 'manual' })
check(
  'google start either redirects or reports it is unconfigured',
  start.status === 302 || start.status === 503,
  `status ${start.status}`,
)
const badState = await fetch(`${BASE}/api/auth/google/callback?state=forged&code=abc`)
check(
  'a callback with an unknown state is a 4xx, not a 500',
  badState.status === 400 || badState.status === 503,
  `status ${badState.status}`,
)

const logout = await fetch(`${BASE}/api/auth/logout`, {
  method: 'POST',
  headers: cookie(BUYERS.doomed),
})
check(
  'logout clears the cookie',
  logout.status === 200 && /Max-Age=0/i.test(logout.headers.get('set-cookie') ?? ''),
  logout.headers.get('set-cookie') ?? 'no set-cookie',
)
const afterLogout = await fetch(`${BASE}/api/auth/me`, { headers: cookie(BUYERS.doomed) })
check('logout revokes the session', afterLogout.status === 401, `status ${afterLogout.status}`)

// A coordinate that is present but unusable is a client bug, not a reason to
// quietly file the buyer under some other cell.
const badCoordsOpened = await new Promise((resolve) => {
  const ws = new WebSocket(`${WS}/api/pool/ws?lat=north&lng=west`, { headers: cookie(BUYERS.bad) })
  ws.addEventListener('open', () => {
    ws.close()
    resolve(true)
  })
  ws.addEventListener('error', () => resolve(false))
  setTimeout(() => resolve(false), 4000)
})
check('an unusable coordinate is refused rather than relocated', badCoordsOpened === false)

// --- live pairing ---
/**
 * Open a pool socket. Pass `null, null` for coordinates to exercise the path a
 * phone with location denied takes: nothing is sent, and the server resolves the
 * cell itself (from `request.cf` when deployed, from the demo origin locally).
 */
function open(buyer, lat, lng, dealId = 'mcd-nuggets-20', forgedName = null) {
  const name = buyer.name
  const placed = lat !== null && lat !== undefined && lng !== null && lng !== undefined
  const params = new URLSearchParams()
  if (placed) {
    params.set('lat', String(lat))
    params.set('lng', String(lng))
  }
  const query = params.toString()
  const ws = new WebSocket(`${WS}/api/pool/ws${query === '' ? '' : `?${query}`}`, {
    headers: cookie(buyer),
  })
  const inbox = []
  const waiters = []
  // Errors are asserted on in sequence, so each one is consumed rather than
  // every check re-reading the first error that ever arrived.
  let errorCursor = 0
  let keepalive = null
  const stopKeepalive = () => {
    if (keepalive !== null) clearInterval(keepalive)
    keepalive = null
  }
  ws.addEventListener('close', stopKeepalive)
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
    // Hold this socket's seat the way the browser client does. A queued buyer
    // who says nothing is supposed to be dropped, so a harness that never pings
    // would age its own fixtures out of the market on a short-window server.
    if (msg.type === 'welcome' && keepalive === null) {
      const every = Math.max(1_000, Math.floor((msg.expiry?.queueIdleMs ?? 60_000) / 3))
      keepalive = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', at: Date.now() }))
      }, every)
      // Never let a keepalive be the reason the process will not exit.
      keepalive.unref?.()
    }
    const w = waiters.find((x) => x.type === msg.type)
    if (w) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(msg)
    }
  })
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  return {
    ws,
    name,
    inbox,
    opened,
    /** Go deliberately quiet, to be aged out of the queue. */
    stopKeepalive,
    expect(type, ms = 4000) {
      const found = inbox.find((m) => m.type === type)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve })
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${type}`)), ms)
      })
    },
    /** The next error not yet asserted on. */
    expectError(ms = 4000) {
      for (let i = errorCursor; i < inbox.length; i++) {
        if (inbox[i].type !== 'error') continue
        errorCursor = i + 1
        return Promise.resolve(inbox[i])
      }
      return new Promise((resolve, reject) => {
        waiters.push({
          type: 'error',
          resolve: (msg) => {
            errorCursor = inbox.length
            resolve(msg)
          },
        })
        setTimeout(() => reject(new Error(`${name}: timed out waiting for an error`)), ms)
      })
    },
    /** Has a message of this type turned up by now? Used to assert absence. */
    async settles(type, ms = 600) {
      await new Promise((r) => setTimeout(r, ms))
      return inbox.some((m) => m.type === type)
    },
    /**
     * Take a seat. `extra` is merged into the frame, so a check can send a sauce
     * pair — or something that only looks like one.
     */
    join(extra = {}) {
      // `forgedName` proves the server ignores a client-supplied name: the buddy
      // is shown the name on the session, never this one.
      const payload = { type: 'join', dealId }
      if (placed) {
        payload.lat = lat
        payload.lng = lng
      }
      if (forgedName !== null) payload.name = forgedName
      Object.assign(payload, extra)
      ws.send(JSON.stringify(payload))
    },
    /** A receiver sends the code off their bud's receipt; an orderer just taps. */
    confirm(code) {
      const payload = { type: 'confirm_pickup' }
      if (code !== undefined) payload.code = code
      ws.send(JSON.stringify(payload))
    },
  }
}

// Two buyers, same block. Coordinates come from FIXTURE_COORDS — see that
// file for why (test/smoke-fixture-cells.test.ts checks every scenario's
// coordinates land in a cell of its own).
const a = open(BUYERS.robb, FIXTURE_COORDS.robb.lat, FIXTURE_COORDS.robb.lng)
const b = open(
  BUYERS.dana,
  FIXTURE_COORDS.dana.lat,
  FIXTURE_COORDS.dana.lng,
  'mcd-nuggets-20',
  'Definitely Not Dana',
)
await Promise.all([a.opened, b.opened])

const welcomeA = await a.expect('welcome')
check(
  'welcome carries a cell',
  typeof welcomeA.cell === 'string' && welcomeA.cell.length === 6,
  welcomeA.cell,
)
check(
  'welcome carries the authenticated identity',
  welcomeA.user?.id === BUYERS.robb.userId && welcomeA.user?.name === 'Robb',
  JSON.stringify(welcomeA.user),
)
check(
  'welcome names the rung that placed the socket',
  welcomeA.locationSource === 'client',
  `${welcomeA.locationSource}`,
)

a.join()
const waitingA = await a.expect('waiting')
check(
  'first buyer queues',
  waitingA.waiting === 1 && waitingA.queuedAhead === 0,
  JSON.stringify(waitingA),
)

b.join()
const [matchA, matchB] = await Promise.all([a.expect('matched'), b.expect('matched')])
check(
  'both buyers matched',
  matchA.matchId === matchB.matchId,
  `${matchA.matchId} / ${matchB.matchId}`,
)
check(
  'roles are complementary',
  matchA.role === 'orderer' && matchB.role === 'receiver',
  `${matchA.role}/${matchB.role}`,
)
check('longest waiter orders', matchA.role === 'orderer')
check('each pays $4.49', matchA.share.payCents === 449 && matchB.share.payCents === 449)
check('each owed 10pc', matchA.share.piecesOwed === 10 && matchB.share.piecesOwed === 10)
check('each saves $2.50', matchA.share.savingsCents === 250)
check(
  'buddy names come from the session, not the join message',
  matchA.buddy.name === 'Dana' && matchB.buddy.name === 'Robb',
  `${matchA.buddy.name}/${matchB.buddy.name}`,
)
check(
  'a buyer who picked no sauces has none shown to their bud',
  matchA.buddy.sauces === null && matchB.buddy.sauces === null,
  `${JSON.stringify(matchA.buddy.sauces)}/${JSON.stringify(matchB.buddy.sauces)}`,
)
check(
  'distance is a short walk',
  matchA.buddy.distanceMeters < 100,
  `${Math.round(matchA.buddy.distanceMeters)}m`,
)
check(
  'only the orderer is given the pickup code',
  typeof matchA.pickupCode === 'string' && matchA.pickupCode.length === 6,
  `orderer ${matchA.pickupCode}`,
)
check(
  'the receiver is not given the pickup code',
  matchB.pickupCode === null,
  `${matchB.pickupCode}`,
)
check(
  'pickup code is not derived from the match id',
  matchA.pickupCode !== matchA.matchId.replace(/-/g, '').slice(0, 6).toUpperCase(),
  `${matchA.pickupCode} vs ${matchA.matchId}`,
)

// A buyer too far away must not pair, even in the same cell region.
const far = open(BUYERS.far, FIXTURE_COORDS.far.lat, FIXTURE_COORDS.far.lng)
await far.opened
far.join()
const farWaiting = await far.expect('waiting')
check('distant buyer waits alone', farWaiting.waiting >= 1, JSON.stringify(farWaiting))

// Abandonment returns the survivor to the queue.
a.ws.close()
const left = await b.expect('buddy_left')
check('survivor told their bud left', left.matchId === matchA.matchId)
const requeued = await b.expect('waiting')
check('survivor requeued', requeued.waiting >= 1, JSON.stringify(requeued))
// Then leave this cell empty. Robb and Dana sit in `9q8znb`, which is the cell
// `DEMO_ORIGIN` (37.7955, -122.3937) encodes to — and that is where the server
// puts a socket that sent no coordinates. The promptless pair far below cannot
// pick a cell of its own, so its isolation has to come from this side: a
// survivor left queued here is 43m from where an unplaced buyer lands, well
// inside MATCH_RADIUS_METERS, and would be matched with them instead of with
// their own bud. Closing the socket dequeues them.
b.ws.close()

// --- the pickup handshake ---
// A different neighbourhood (geohash `9q9p3w`, ~14m apart), so this pair cannot
// be matched with anyone still queued above: only one deal is offered now, so
// the cell is the axis that isolates a market, not the deal.
const g = open(BUYERS.gus, FIXTURE_COORDS.gus.lat, FIXTURE_COORDS.gus.lng)
const h = open(BUYERS.hana, FIXTURE_COORDS.hana.lat, FIXTURE_COORDS.hana.lng)
await Promise.all([g.opened, h.opened])
await Promise.all([g.expect('welcome'), h.expect('welcome')])
g.join()
await g.expect('waiting')
h.join()
const [orderer, receiver] = await Promise.all([g.expect('matched'), h.expect('matched')])
check(
  'handshake pair matched in their own cell',
  orderer.matchId === receiver.matchId && orderer.role === 'orderer',
  `${orderer.role}/${receiver.role}`,
)

// A receiver who never met their bud cannot talk their way through.
h.confirm('ZZZZZZ')
const wrongCode = await h.expectError()
check('a wrong code is rejected', wrongCode.code === 'bad_pickup_code', wrongCode.code)
h.confirm()
const noCode = await h.expectError()
check(
  'a receiver cannot confirm with no code at all',
  noCode.code === 'bad_pickup_code',
  noCode.code,
)
check('a wrong code completes nothing', (await h.settles('pickup_complete')) === false)
check('a wrong code confirms nothing', (await h.settles('pickup_confirmed')) === false)

// The real code, typed the way a person types it.
const typed = `${orderer.pickupCode.slice(0, 3)}-${orderer.pickupCode.slice(3).toLowerCase()}`
h.confirm(typed)
const [confirmedForOrderer, confirmedForReceiver] = await Promise.all([
  g.expect('pickup_confirmed'),
  h.expect('pickup_confirmed'),
])
check(
  'both sides see the receiver confirm',
  confirmedForOrderer.by === 'receiver' && confirmedForReceiver.by === 'receiver',
  `${confirmedForOrderer.by}/${confirmedForReceiver.by}`,
)
check(
  'the orderer is still owed a confirmation',
  confirmedForOrderer.waitingOn === 'orderer',
  `${confirmedForOrderer.waitingOn}`,
)
check(
  'a dispute deadline is armed on the half-confirmed match',
  typeof confirmedForOrderer.disputeAt === 'number' &&
    confirmedForOrderer.disputeAt > Date.now() + 60_000,
  `${confirmedForOrderer.disputeAt}`,
)
check('one side confirming does not settle', (await h.settles('pickup_complete')) === false)

h.confirm(orderer.pickupCode)
const twice = await h.expectError()
check(
  'a second confirmation from the same side is refused',
  twice.code === 'already_confirmed',
  twice.code,
)

// The orderer taps, and only now does the split settle.
g.confirm()
const [doneForOrderer, doneForReceiver] = await Promise.all([
  g.expect('pickup_complete'),
  h.expect('pickup_complete'),
])
check(
  'both sides get the same completion',
  doneForOrderer.matchId === orderer.matchId && doneForReceiver.matchId === orderer.matchId,
  `${doneForOrderer.matchId}`,
)
check(
  'completion is stamped',
  typeof doneForOrderer.settledAt === 'number' && doneForOrderer.settledAt > 0,
  `${doneForOrderer.settledAt}`,
)
// Completion, and only completion, is what books a split.
const booked = ledgerQuery(`SELECT * FROM matches WHERE match_id = '${orderer.matchId}'`)
check(
  'the settled split is written to the ledger',
  booked.length === 1 &&
    booked[0].settled_at > 0 &&
    booked[0].total_collected_cents === orderer.settlement.totalCollectedCents,
  JSON.stringify(booked[0] ?? null),
)
const bookedBuyers = ledgerQuery(
  `SELECT role, pay_cents FROM match_buyers WHERE match_id = '${orderer.matchId}' ORDER BY role`,
)
check(
  'both halves are booked, and they sum to the total',
  bookedBuyers.length === 2 &&
    bookedBuyers.reduce((sum, row) => sum + row.pay_cents, 0) ===
      orderer.settlement.totalCollectedCents,
  JSON.stringify(bookedBuyers),
)
const unsettled = ledgerQuery(`SELECT match_id FROM matches WHERE match_id = '${matchA.matchId}'`)
check('an abandoned match is never booked', unsettled.length === 0, JSON.stringify(unsettled))

g.confirm()
const afterSettled = await g.expectError()
check(
  'a settled match cannot be confirmed again',
  afterSettled.code === 'not_matched',
  afterSettled.code,
)

// One-sided confirmation plus a vanished bud is a dispute, never a settlement.
// The other route to the same state — the confirmation timeout — is not run
// here because it would mean holding this script open for PICKUP_CONFIRM_TIMEOUT_MS.
// To drive it by hand, put `PICKUP_CONFIRM_TIMEOUT_MS="2000"` in `.dev.vars`,
// restart the dev server, and half-confirm a match: the alarm disputes it.
// Again a cell of their own (`9q9k6m`), so the dispute below is unambiguously
// this pair's and cannot draw in a buyer left queued by an earlier scenario.
const i = open(BUYERS.ivy, FIXTURE_COORDS.ivy.lat, FIXTURE_COORDS.ivy.lng)
const j = open(BUYERS.jed, FIXTURE_COORDS.jed.lat, FIXTURE_COORDS.jed.lng)
await Promise.all([i.opened, j.opened])
await Promise.all([i.expect('welcome'), j.expect('welcome')])
i.join()
await i.expect('waiting')
j.join()
const [ordererI, receiverJ] = await Promise.all([i.expect('matched'), j.expect('matched')])
j.confirm(ordererI.pickupCode)
await j.expect('pickup_confirmed')
i.ws.close()
const disputed = await j.expect('pickup_disputed')
check(
  'a bud who leaves after one confirmation raises a dispute',
  disputed.matchId === receiverJ.matchId && disputed.confirmedBy === 'receiver',
  JSON.stringify(disputed),
)
check('a disputed match never settles', (await j.settles('pickup_complete')) === false)
check(
  'a disputed match does not quietly requeue the survivor',
  (await j.settles('waiting')) === false,
)
const disputedRows = ledgerQuery(
  `SELECT match_id FROM matches WHERE match_id = '${receiverJ.matchId}'`,
)
check('a disputed match is never booked', disputedRows.length === 0, JSON.stringify(disputedRows))
j.confirm(ordererI.pickupCode)
const afterDispute = await j.expectError()
check(
  'a disputed match cannot be confirmed away',
  afterDispute.code === 'not_matched',
  afterDispute.code,
)

// --- pairing with no location permission at all ---
// Neither of these sends a coordinate, in the upgrade or in the join, which is
// what a phone with location denied does. The server places both from
// `request.cf`, and from the fixed demo origin when there is no `cf` to read —
// miniflare usually supplies one locally, but an offline or trimmed one has no
// coordinates, so both answers are acceptable here as long as a cell comes out.
//
// Every other scenario isolates itself by choosing a cell. This one cannot:
// choosing nothing is the point. There are exactly two cells it can land in, and
// the suite keeps both clear instead —
//   * `9q8yyk`, from miniflare's cached `cf` (37.77493, -122.41942), which sits
//     108m inside the nearest edge of that cell. No scenario here is placed in
//     it at all.
//   * `9q8znb`, the demo origin's cell, with the origin 281m inside its nearest
//     edge. The opening pair is the only one placed there, and both of its
//     sockets are closed before this point.
// The `waiting === 1` check below is what keeps that argument honest rather than
// merely written down: a buyer left queued in whichever cell the server picks
// would show up as a second waiter, or would be matched with one of these two
// before the other ever joined.
//
// Isolating by a second deal id — which is what this scenario used to do — is no
// longer available: only McDonald's is offered, and a join naming any other
// chain is refused (the gate checks are a few dozen lines below).
const k = open(BUYERS.kai, null, null)
const l = open(BUYERS.lex, null, null)
await Promise.all([k.opened, l.opened])
const welcomeK = await k.expect('welcome')
check(
  'a socket with no coordinates still resolves a cell',
  typeof welcomeK.cell === 'string' && welcomeK.cell.length === 6,
  `${welcomeK.cell}`,
)
check(
  'and says which rung placed it, never claiming an exact fix',
  welcomeK.locationSource === 'edge' || welcomeK.locationSource === 'demo',
  `${welcomeK.locationSource} — 'edge' when request.cf carries coordinates, 'demo' when it does not`,
)
await l.expect('welcome')
k.join()
const waitingK = await k.expect('waiting')
check(
  'a buyer the server placed has the cell it placed them in to themselves',
  waitingK.waiting === 1 && waitingK.buddies.length === 0,
  `${welcomeK.cell} ${JSON.stringify(waitingK)}`,
)
l.join()
const [matchK, matchL] = await Promise.all([k.expect('matched'), l.expect('matched')])
check(
  'two buyers who never shared their location pair anyway',
  matchK.matchId === matchL.matchId,
  `${matchK.matchId} / ${matchL.matchId}`,
)
// The catalogue is the source of truth for prices, so this reads the half off
// the deal rather than restating a number.
const promptlessHalf = mcd.settlement.shares[1].payCents
check(
  'the split is the same as any other pairing on this deal',
  matchK.share.payCents === promptlessHalf && matchL.share.payCents === promptlessHalf,
  `${matchK.share.payCents}/${matchL.share.payCents} vs ${promptlessHalf}`,
)
check(
  'distance is measured from the server-resolved origin',
  matchK.buddy.distanceMeters < 1,
  `${matchK.buddy.distanceMeters}m`,
)

// Protocol hygiene. This deliberately reopens a socket in the opening pair's
// cell (FIXTURE_COORDS.badRejoin *is* FIXTURE_COORDS.robb — see
// scripts/smoke-fixtures.mjs) now that both `a` and `b` have closed theirs, a
// couple dozen lines up. It is the one declared exception in
// test/smoke-fixture-cells.test.ts ('forged-rejoin'): do not give this socket
// a coordinate of its own without also removing that exception.
const c = open(BUYERS.bad, FIXTURE_COORDS.badRejoin.lat, FIXTURE_COORDS.badRejoin.lng)
await c.opened
await c.expect('welcome')
c.ws.send('this is not json')
const err = await c.expectError()
check('garbage rejected', err.code === 'bad_message', err.code)
c.confirm('A2B3C4')
const unmatched = await c.expectError()
check('confirming without a match is refused', unmatched.code === 'not_matched', unmatched.code)
/** Send a hand-rolled `join` frame, bypassing whatever the UI would offer. */
const rawJoin = (socket, dealId) =>
  socket.ws.send(
    JSON.stringify({
      type: 'join',
      dealId,
      lat: FIXTURE_COORDS.badRejoin.lat,
      lng: FIXTURE_COORDS.badRejoin.lng,
    }),
  )

rawJoin(c, 'no-such-deal')
const unknownDeal = await c.expectError()
check('unknown deal rejected over ws', unknownDeal.code === 'unknown_deal', unknownDeal.code)

// The pairing path, not the storefront. `/api/deals` only ever lists what is
// offered, but nothing stops a client sending its own `join` frame naming a
// gated chain — and being paired there means being *settled* there. The gate has
// to hold on this socket, not just on the listing.
rawJoin(c, 'wendys-nuggets-20')
const gatedJoin = await c.expectError()
check(
  'a gated deal is refused on the pairing path',
  gatedJoin.code === 'unknown_deal',
  gatedJoin.code,
)
rawJoin(c, 'bk-nuggets-20')
const gatedJoin2 = await c.expectError()
check(
  'every gated deal is refused on the pairing path',
  gatedJoin2.code === 'unknown_deal',
  gatedJoin2.code,
)
// Refusing with an error is not enough: a buyer queued on a gated deal would sit
// in the pool waiting for a buddy who can never legitimately arrive.
check('a refused gated join never queues the buyer', (await c.settles('waiting')) === false)

// --- cell map roster broadcast ---
// The cell map needs everyone's client to hear about a roster change, not just
// the socket that caused it — so a buyer joining the cell must push a fresh
// 'waiting' message to every buyer already queued there, with the newcomer's
// position quantized rather than exact.
//
// Isolated by cell, like the handshake pairs above: `9q8yx1` is a neighbourhood
// nobody else in this suite touches, so the roster kim and lee see is only ever
// each other. Isolating by a second deal id is no longer possible — one chain is
// offered, and a join naming any other is refused three checks above.
//
// They also must not pair with each other, and the axis left for that is
// distance: both sit inside `9q8yx1` but 1055m apart, beyond the 800m
// MATCH_RADIUS_METERS. That is the "cell-edge buddies" case wrangler.jsonc
// documents — same market, too far to walk — and it is what makes the roster
// assertion below discriminating: a buddy appears on the map who this buyer
// could not be matched with.
const KIM_AT = FIXTURE_COORDS.kim
const LEE_AT = FIXTURE_COORDS.lee

const kim = open(BUYERS.kim, KIM_AT.lat, KIM_AT.lng)
await kim.opened
const kimWelcome = await kim.expect('welcome')
kim.join()
const kimAlone = await kim.expect('waiting')
check(
  'the first buyer in a fresh cell has an empty roster',
  kimWelcome.cell === '9q8yx1' && kimAlone.buddies.length === 0,
  `${kimWelcome.cell} ${JSON.stringify(kimAlone.buddies)}`,
)

const kimWaitingBefore = kim.inbox.filter((m) => m.type === 'waiting').length
const lee = open(BUYERS.lee, LEE_AT.lat, LEE_AT.lng)
await lee.opened
const leeWelcome = await lee.expect('welcome')
lee.join()
const leeWaiting = await lee.expect('waiting')
check(
  // Same cell and same deal, so both are queued in one market, yet too far
  // apart to be matched — the roster still carries the other.
  'the roster carries a cell buddy who is out of pairing range',
  leeWelcome.cell === kimWelcome.cell &&
    leeWaiting.waiting === 2 &&
    leeWaiting.buddies.length === 1,
  `${leeWelcome.cell} ${JSON.stringify(leeWaiting)}`,
)

const broadcastSeen = await (async () => {
  for (let i = 0; i < 40; i++) {
    if (kim.inbox.filter((m) => m.type === 'waiting').length > kimWaitingBefore) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
})()
check(
  'a buyer already queued gets a fresh roster broadcast when someone new joins the cell',
  broadcastSeen,
  `${kimWaitingBefore} -> ${kim.inbox.filter((m) => m.type === 'waiting').length}`,
)

const latestForKim = kim.inbox.filter((m) => m.type === 'waiting').at(-1)
check(
  'the broadcast roster carries a position for the newcomer',
  latestForKim.buddies.some(
    (pos) => Math.abs(pos.lat - LEE_AT.lat) < 0.01 && Math.abs(pos.lng - LEE_AT.lng) < 0.01,
  ),
  JSON.stringify(latestForKim.buddies),
)
check(
  'the broadcast never carries an exact coordinate for anyone else',
  latestForKim.buddies.every((pos) => pos.lat !== LEE_AT.lat || pos.lng !== LEE_AT.lng),
  JSON.stringify(latestForKim.buddies),
)

for (const s of [b, far, c, g, h, j, k, l, kim, lee]) s.ws.close()

// --- sauces off a socket ---
// Seattle (`c23nb`), nowhere near any pair above, so these two can only match
// with each other. The point of these checks is that the sauce ids are validated
// on the *request path* rather than by a unit test calling the validator: this
// repo has shipped three predicates that existed and enforced nothing.
const sal = open(BUYERS.sal, FIXTURE_COORDS.sal.lat, FIXTURE_COORDS.sal.lng)
const nia = open(BUYERS.nia, FIXTURE_COORDS.nia.lat, FIXTURE_COORDS.nia.lng)
await Promise.all([sal.opened, nia.opened])
await Promise.all([sal.expect('welcome'), nia.expect('welcome')])

sal.join({ sauces: ['mcd-ketchup', 'mcd-liquid-gold'] })
const unknownSauce = await sal.expectError()
check(
  'a sauce that is not on the menu is refused',
  unknownSauce.code === 'unknown_sauce',
  unknownSauce.code,
)
check(
  'the refusal does not echo the id back over the socket',
  !JSON.stringify(unknownSauce).includes('liquid-gold'),
  unknownSauce.message,
)
check('a refused join seats nobody', (await sal.settles('waiting')) === false)

// A real sauce of a chain the app does not pair on: it resolves in the catalogue,
// which is the reason this is the harder case and not the easy one.
sal.join({ sauces: ['bk-zesty', 'bk-zesty'] })
const gatedOnSocket = await sal.expectError()
check(
  'a gated chain’s sauce is refused on the wire too',
  gatedOnSocket.code === 'unknown_sauce',
  gatedOnSocket.code,
)

// Malformed is a different answer from unknown: one is a broken frame, the other
// is a buyer asking for something that does not exist.
sal.join({ sauces: 'mcd-ketchup' })
const malformedSauces = await sal.expectError()
check(
  'a malformed sauce field is a bad message',
  malformedSauces.code === 'bad_message',
  malformedSauces.code,
)
check('none of that queued the buyer', (await sal.settles('waiting')) === false)

sal.join({ sauces: ['mcd-hot-mustard', 'mcd-ketchup'] })
const salWaiting = await sal.expect('waiting')
check('a pair from the menu takes its seat', salWaiting.waiting >= 1, JSON.stringify(salWaiting))

// The practical half: whoever is standing at the counter has to know what the
// other one wants, and a double order of one sauce is a real answer.
nia.join({ sauces: ['mcd-sweet-n-sour', 'mcd-sweet-n-sour'] })
const [salMatch, niaMatch] = await Promise.all([sal.expect('matched'), nia.expect('matched')])
check(
  'each bud is told the other’s sauces, in catalogue order',
  salMatch.buddy.sauces?.join() === 'mcd-sweet-n-sour,mcd-sweet-n-sour' &&
    niaMatch.buddy.sauces?.join() === 'mcd-hot-mustard,mcd-ketchup',
  `${JSON.stringify(salMatch.buddy.sauces)} / ${JSON.stringify(niaMatch.buddy.sauces)}`,
)

for (const s of [sal, nia]) s.ws.close()

// --- liveness: stale queue entries and unconfirmed matches ---
const windows = welcomeA.expiry ?? {}
check(
  'welcome carries the cell liveness windows',
  Number.isFinite(windows.queueIdleMs) && Number.isFinite(windows.matchTimeoutMs),
  JSON.stringify(windows),
)

// Far from the pairing checks above, so these buyers neither disturb them nor
// get pulled into a match by them.
const pinger = open(BUYERS.pinger, FIXTURE_COORDS.pinger.lat, FIXTURE_COORDS.pinger.lng)
await pinger.opened
await pinger.expect('welcome')
pinger.join()
await pinger.expect('waiting')
pinger.ws.send(JSON.stringify({ type: 'ping', at: 4242 }))
// Matched on `at` rather than taking the first pong: the harness keepalive is
// also pinging, so several pongs are legitimately in flight.
const sawPong = await (async () => {
  for (let i = 0; i < 40; i++) {
    if (pinger.inbox.some((msg) => msg.type === 'pong' && msg.at === 4242)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
})()
check('a ping is answered while queued', sawPong)

const shortWindows = windows.queueIdleMs <= 20_000 && windows.matchTimeoutMs <= 20_000
if (!shortWindows) {
  log(
    `SKIP  expiry — this server ages entries out after ${Math.round(windows.queueIdleMs / 1000)}s. ` +
      'Set QUEUE_IDLE_SECONDS / QUEUE_WARN_LEAD_SECONDS / MATCH_CONFIRM_SECONDS in .dev.vars to run them.',
  )
} else {
  const patience = (ms) => ms + 6_000

  // A buyer who joins and walks away must be warned, then dropped.
  const stale = open(BUYERS.stale, FIXTURE_COORDS.stale.lat, FIXTURE_COORDS.stale.lng)
  await stale.opened
  await stale.expect('welcome')
  // The one socket that must not hold its own seat.
  stale.stopKeepalive()
  stale.join()
  await stale.expect('waiting')
  const expiring = await stale.expect('queue_expiring', patience(windows.queueIdleMs))
  check(
    'a quiet buyer is warned before being dropped',
    Number.isFinite(expiring.expiresAt),
    JSON.stringify(expiring),
  )
  const expired = await stale.expect('queue_expired', patience(windows.queueIdleMs))
  check(
    'a quiet buyer is dropped and told why',
    expired.reason === 'idle' && expired.idleMs === windows.queueIdleMs,
    JSON.stringify(expired),
  )

  // A match neither half confirms must be called off for both of them.
  const slowOne = open(BUYERS.slowOne, FIXTURE_COORDS.slowOne.lat, FIXTURE_COORDS.slowOne.lng)
  const slowTwo = open(BUYERS.slowTwo, FIXTURE_COORDS.slowTwo.lat, FIXTURE_COORDS.slowTwo.lng)
  await Promise.all([slowOne.opened, slowTwo.opened])
  await Promise.all([slowOne.expect('welcome'), slowTwo.expect('welcome')])
  slowOne.join()
  await slowOne.expect('waiting')
  slowTwo.join()
  const [slowMatch] = await Promise.all([slowOne.expect('matched'), slowTwo.expect('matched')])
  const [cancelOne, cancelTwo] = await Promise.all([
    slowOne.expect('match_expired', patience(windows.matchTimeoutMs)),
    slowTwo.expect('match_expired', patience(windows.matchTimeoutMs)),
  ])
  check(
    'an unconfirmed match is cancelled for both halves',
    cancelOne.matchId === slowMatch.matchId && cancelTwo.matchId === slowMatch.matchId,
    `${cancelOne.matchId} / ${cancelTwo.matchId}`,
  )
  check(
    'a cancelled match returns nothing, because nothing was taken yet',
    cancelOne.refundedCents === 0 && cancelTwo.refundedCents === 0,
  )

  // The boundary between the two timers, which is the thing most easily broken
  // by wiring expiry in next to the handshake: once one side has confirmed, the
  // match belongs to the dispute path and the expiry sweep must not touch it.
  // Cancelling it here would erase a buddy's claim that the nuggets changed
  // hands — exactly what the two-sided handshake exists to prevent.
  const halfOne = open(BUYERS.halfOne, FIXTURE_COORDS.halfOne.lat, FIXTURE_COORDS.halfOne.lng)
  const halfTwo = open(BUYERS.halfTwo, FIXTURE_COORDS.halfTwo.lat, FIXTURE_COORDS.halfTwo.lng)
  await Promise.all([halfOne.opened, halfTwo.opened])
  await Promise.all([halfOne.expect('welcome'), halfTwo.expect('welcome')])
  halfOne.join()
  await halfOne.expect('waiting')
  halfTwo.join()
  const [halfMatchOne] = await Promise.all([halfOne.expect('matched'), halfTwo.expect('matched')])
  // The orderer confirms by tapping; only they need no code to do it.
  const orderer = halfMatchOne.role === 'orderer' ? halfOne : halfTwo
  orderer.confirm()
  const halfConfirmed = await halfOne.expect('pickup_confirmed')
  check(
    'one side confirming is recorded and still waiting on the other',
    halfConfirmed.waitingOn !== null && halfConfirmed.disputeAt !== null,
    JSON.stringify(halfConfirmed),
  )
  // Waited out the whole window that *would* have cancelled it unconfirmed.
  const hijacked = await halfOne.settles('match_expired', patience(windows.matchTimeoutMs))
  check(
    'a half-confirmed match is left to the dispute path, not expiry-cancelled',
    hijacked === false,
    JSON.stringify(halfOne.inbox.map((m) => m.type)),
  )

  for (const s of [stale, slowOne, slowTwo, halfOne, halfTwo]) s.ws.close()
}

pinger.ws.close()

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

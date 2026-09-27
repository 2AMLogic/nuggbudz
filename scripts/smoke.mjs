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
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const BUYERS = {
  robb: { sid: sessionId('smoke-robb'), userId: 'smoke-user-robb', name: 'Robb' },
  dana: { sid: sessionId('smoke-dana'), userId: 'smoke-user-dana', name: 'Dana' },
  far: { sid: sessionId('smoke-faraway'), userId: 'smoke-user-faraway', name: 'Faraway' },
  bad: { sid: sessionId('smoke-bad'), userId: 'smoke-user-bad', name: 'Bad' },
  // Signed in only to be signed out again.
  doomed: { sid: sessionId('smoke-doomed'), userId: 'smoke-user-doomed', name: 'Doomed' },
  // The pickup handshake pair, and the pair that never finishes one.
  gus: { sid: sessionId('smoke-gus'), userId: 'smoke-user-gus', name: 'Gus' },
  hana: { sid: sessionId('smoke-hana'), userId: 'smoke-user-hana', name: 'Hana' },
  ivy: { sid: sessionId('smoke-ivy'), userId: 'smoke-user-ivy', name: 'Ivy' },
  jed: { sid: sessionId('smoke-jed'), userId: 'smoke-user-jed', name: 'Jed' },
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

seedSessions()
applyMigrations()
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

// --- live pairing ---
function open(buyer, lat, lng, dealId = 'mcd-nuggets-20', forgedName = null) {
  const name = buyer.name
  const ws = new WebSocket(`${WS}/api/pool/ws?lat=${lat}&lng=${lng}`, { headers: cookie(buyer) })
  const inbox = []
  const waiters = []
  // Errors are asserted on in sequence, so each one is consumed rather than
  // every check re-reading the first error that ever arrived.
  let errorCursor = 0
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
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
    join() {
      // `forgedName` proves the server ignores a client-supplied name: the buddy
      // is shown the name on the session, never this one.
      const payload = { type: 'join', dealId, lat, lng }
      if (forgedName !== null) payload.name = forgedName
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

// Two buyers, same block.
const a = open(BUYERS.robb, 37.7955, -122.3937)
const b = open(BUYERS.dana, 37.7958, -122.394, 'mcd-nuggets-20', 'Definitely Not Dana')
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
const far = open(BUYERS.far, 37.84, -122.3937)
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

// --- the pickup handshake ---
// A different neighbourhood (geohash `9q9p3w`, ~14m apart), so this pair cannot
// be matched with anyone still queued above: only one deal is offered now, so
// the cell is the axis that isolates a market, not the deal.
const g = open(BUYERS.gus, 37.8715, -122.273)
const h = open(BUYERS.hana, 37.8716, -122.2731)
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
const i = open(BUYERS.ivy, 37.3382, -121.8863)
const j = open(BUYERS.jed, 37.3383, -121.8864)
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

// Protocol hygiene.
const c = open(BUYERS.bad, 37.7955, -122.3937)
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
  socket.ws.send(JSON.stringify({ type: 'join', dealId, lat: 37.7955, lng: -122.3937 }))

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

for (const s of [b, far, c, g, h, j]) s.ws.close()

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

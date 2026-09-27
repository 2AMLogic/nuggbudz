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

seedSessions()
const cookie = (buyer) => ({ Cookie: `nb_session=${buyer.sid}` })

// --- REST surface ---
const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
check('health ok', health.ok === true, JSON.stringify(health))

const { deals } = await fetch(`${BASE}/api/deals`).then((r) => r.json())
check(
  'deals catalogue returned',
  Array.isArray(deals) && deals.length === 3,
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
    join() {
      // `forgedName` proves the server ignores a client-supplied name: the buddy
      // is shown the name on the session, never this one.
      const payload = { type: 'join', dealId, lat, lng }
      if (forgedName !== null) payload.name = forgedName
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

// Protocol hygiene.
const c = open(BUYERS.bad, 37.7955, -122.3937)
await c.opened
await c.expect('welcome')
c.ws.send('this is not json')
const err = await c.expect('error')
check('garbage rejected', err.code === 'bad_message', err.code)
c.ws.send(
  JSON.stringify({
    type: 'join',
    dealId: 'no-such-deal',
    lat: 37.7955,
    lng: -122.3937,
  }),
)
const sawUnknownDeal = await (async () => {
  for (let i = 0; i < 40; i++) {
    if (c.inbox.some((m) => m.code === 'unknown_deal')) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
})()
check(
  'unknown deal rejected over ws',
  sawUnknownDeal,
  JSON.stringify(c.inbox.filter((m) => m.type === 'error')),
)

for (const s of [b, far, c]) s.ws.close()

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

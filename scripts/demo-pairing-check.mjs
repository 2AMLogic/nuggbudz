#!/usr/bin/env node
/**
 * Verifies whichever pairing mode the target server is actually in.
 *
 * `scripts/smoke.mjs` covers the authenticated path by seeding sessions into KV.
 * This checks the mode boundary instead, reading `/api/health` to find out which
 * side of it the server sits on:
 *
 *   demoPairing false ⇒ an unauthenticated upgrade must be refused (401).
 *   demoPairing true  ⇒ two unauthenticated clients must pair with each other,
 *                       under the names they proposed, with `demo:` identities,
 *                       run the whole pickup handshake to `pickup_complete`,
 *                       and leave the D1 ledger completely untouched.
 *
 * Both directions matter: the flag existing is not evidence that turning it off
 * still closes the door.
 *
 * The ledger assertion is the one that would have caught the real defect: the
 * demo pair reaches `completeMatch()` exactly as a real pair does, so only
 * reading D1 afterwards proves the split was not booked as revenue.
 *
 * Usage:  BASE=http://localhost:5199 node scripts/demo-pairing-check.mjs
 */
import { execFileSync } from 'node:child_process'

const BASE = process.env.BASE ?? 'http://localhost:5199'
const WS = BASE.replace('http', 'ws')
const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

/**
 * Read the ledger the dev server writes to — the same local D1 wrangler sees.
 *
 * Migrations are applied first so a missing `matches` table cannot make the
 * "nothing was booked" assertion pass for the wrong reason.
 */
function applyMigrations() {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function ledgerQuery(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'nuggbudz', '--local', '--json', '--command', sql],
    { stdio: ['ignore', 'pipe', 'pipe'], env: WRANGLER_ENV },
  )
  return JSON.parse(out.toString())[0]?.results ?? []
}

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
const demo = health.demoPairing === true
console.log(`server reports demoPairing=${health.demoPairing} (protocol ${health.protocol})\n`)

/**
 * Open a demo socket the way a phone now does: a name, and no coordinates.
 *
 * Nothing is sent about where the caller is, so the Worker resolves the cell
 * itself — from `request.cf` on a deployed server, from the demo origin locally.
 * Two clients behind the same connection therefore land in the same market,
 * which is the whole point on a stage where nobody should see a location prompt.
 */
function open(name) {
  const params = new URLSearchParams({ name })
  const ws = new WebSocket(`${WS}/api/pool/ws?${params}`)
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
  return {
    ws,
    inbox,
    opened: new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    }),
    expect(type, ms = 5000) {
      const found = inbox.find((m) => m.type === type)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve })
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${type}`)), ms)
      })
    },
    join(dealId = 'mcd-nuggets-20') {
      ws.send(JSON.stringify({ type: 'join', dealId }))
    },
    /** A receiver sends the code off their bud's receipt; an orderer just taps. */
    confirm(code) {
      const payload = { type: 'confirm_pickup' }
      if (code !== undefined) payload.code = code
      ws.send(JSON.stringify(payload))
    },
  }
}

if (!demo) {
  // Strict mode: the identity gate runs before the upgrade check, so a plain GET
  // exercises it. (undici forbids setting Upgrade/Connection on a fetch, and a
  // real socket would only surface the refusal as an opaque connection error.)
  const res = await fetch(`${BASE}/api/pool/ws`)
  check('unauthenticated upgrade refused', res.status === 401, `status ${res.status}`)
  const body = await res.json().catch(() => ({}))
  check('refusal says why', body.error === 'sign in required', JSON.stringify(body))
} else {
  const a = open('Robb')
  const b = open('Dana')
  await Promise.all([a.opened, b.opened])

  const welcome = await a.expect('welcome')
  check(
    'demo socket is welcomed',
    typeof welcome.cell === 'string' && welcome.cell.length === 6,
    welcome.cell,
  )
  check(
    'welcome carries a demo identity',
    typeof welcome.user?.id === 'string' && welcome.user.id.startsWith('demo:'),
    JSON.stringify(welcome.user),
  )
  check(
    'the cell came from the server, with no coordinates and no prompt',
    welcome.locationSource === 'edge' || welcome.locationSource === 'demo',
    `${welcome.locationSource} — 'edge' from request.cf, 'demo' when there is none to read`,
  )

  a.join()
  await a.expect('waiting')
  b.join()
  const [ma, mb] = await Promise.all([a.expect('matched'), b.expect('matched')])

  check(
    'both unauthenticated clients matched',
    ma.matchId === mb.matchId,
    `${ma.matchId} / ${mb.matchId}`,
  )
  check(
    'roles are complementary',
    ma.role === 'orderer' && mb.role === 'receiver',
    `${ma.role}/${mb.role}`,
  )
  check(
    'proposed names crossed over',
    ma.buddy.name === 'Dana' && mb.buddy.name === 'Robb',
    `${ma.buddy.name}/${mb.buddy.name}`,
  )
  check('settlement still splits to $4.49', ma.share.payCents === 449 && mb.share.payCents === 449)
  check('each saves $2.50', ma.share.savingsCents === 250)

  // --- a demo handoff completes on screen, and books nothing ---
  // The demo is still worth running on a stage: the pair must get all the way to
  // `pickup_complete` and see a receipt. What it must not do is leave a row.
  applyMigrations()
  const before = ledgerQuery('SELECT COUNT(*) AS n FROM matches')[0]?.n ?? 0

  b.confirm(ma.pickupCode)
  await Promise.all([a.expect('pickup_confirmed'), b.expect('pickup_confirmed')])
  a.confirm()
  const [doneA, doneB] = await Promise.all([
    a.expect('pickup_complete'),
    b.expect('pickup_complete'),
  ])
  check(
    'a demo pair completes the whole pickup handshake',
    doneA.matchId === ma.matchId && doneB.matchId === ma.matchId,
    `${doneA.matchId} / ${doneB.matchId}`,
  )
  check(
    'the completion is stamped, so the receipt is real to the user',
    typeof doneA.settledAt === 'number' && doneA.settledAt > 0,
    `${doneA.settledAt}`,
  )

  // Give the write that must not happen time to happen.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const bookedMatch = ledgerQuery(`SELECT * FROM matches WHERE match_id = '${ma.matchId}'`)
  check(
    'a completed demo handoff writes no match row',
    bookedMatch.length === 0,
    JSON.stringify(bookedMatch),
  )
  const bookedBuyers = ledgerQuery(`SELECT * FROM match_buyers WHERE match_id = '${ma.matchId}'`)
  check(
    'a completed demo handoff books no money rows',
    bookedBuyers.length === 0,
    JSON.stringify(bookedBuyers),
  )
  const after = ledgerQuery('SELECT COUNT(*) AS n FROM matches')[0]?.n ?? 0
  check('the ledger row count is unchanged by the demo', after === before, `${before} -> ${after}`)

  for (const s of [a, b]) s.ws.close()
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

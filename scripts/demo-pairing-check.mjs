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
 * Since #101 a demo identity is **per browser**, carried on a cookie, so this
 * script has to behave like two browsers rather than like one process. Each side
 * fetches its own identity from `/api/health` and carries only its own cookie on
 * its own socket, and the check that they came back different is asserted rather
 * than left to the accident that `undici`'s WebSocket has no cookie jar. That
 * accident is one refactor away from collapsing both sides into one buyer and
 * failing mysteriously.
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
 * One browser's cookie jar: fetch `/api/health` from scratch and keep whatever
 * demo identity it hands back.
 *
 * Deliberately *not* shared between the two sides. Sharing it would make them
 * one buyer, the self-match refusal would fire, and this script would stop
 * proving anything about pairing — which is the failure mode #101 warned about
 * and the reason each jar is separate here by construction rather than by luck.
 */
async function freshDemoIdentity(label) {
  const response = await fetch(`${BASE}/api/health`)
  const raw = response.headers.get('set-cookie') ?? ''
  // Treated as opaque, exactly the way a browser treats it: whatever name and
  // value the server set, sent back unread. Naming the cookie here would be a
  // second spelling of something `shared/demo.ts` already owns, and this module
  // is plain Node and cannot import it.
  const pair = raw.split(';')[0].trim()
  if (!pair.includes('=') || pair.endsWith('=')) {
    throw new Error(`${label}: /api/health issued no demo identity cookie — got '${raw}'`)
  }
  return pair
}

/**
 * Open a demo socket the way a phone now does: its own cookie, a name, and no
 * coordinates.
 *
 * Nothing is sent about where the caller is, so the Worker resolves the position
 * itself — from `request.cf` on a deployed server, from the demo origin locally.
 * Two clients behind the same connection therefore land in the same market,
 * which is the whole point on a stage where nobody should see a location prompt.
 */
function open(name, identity) {
  const params = new URLSearchParams({ name })
  const ws = new WebSocket(`${WS}/api/pool/ws?${params}`, { headers: { Cookie: identity } })
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
    /** Has a message of this type turned up by now? Used to assert absence. */
    async settles(type, ms = 600) {
      await new Promise((r) => setTimeout(r, ms))
      return inbox.some((m) => m.type === type)
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
  // Two browsers, two jars. Asserted before anything is opened, so a server that
  // stopped issuing identities — or started issuing one identity to everybody —
  // fails here rather than as a pairing timeout twenty lines down.
  const [jarA, jarB] = await Promise.all([freshDemoIdentity('side A'), freshDemoIdentity('side B')])
  check('each browser is issued its own demo identity', jarA !== jarB, `${jarA} vs ${jarB}`)
  check(
    'and a browser that already has one is not given a second',
    await (async () => {
      const again = await fetch(`${BASE}/api/health`, { headers: { Cookie: jarA } })
      return (again.headers.get('set-cookie') ?? '') === ''
    })(),
    're-issuing one every request would be per-socket minting with extra steps',
  )

  const a = open('Robb', jarA)
  const b = open('Dana', jarB)
  try {
    await Promise.all([a.opened, b.opened])
  } catch (err) {
    // A refused upgrade surfaces as a raw WebSocket `error` event, not an
    // `Error` — reported through `check()` like every other assertion here
    // rather than left to propagate as an uncaught rejection (a ~40-line
    // ErrorEvent dump). The exit code is unchanged: a failed `check()` already
    // makes `failures > 0`, which is the same non-zero exit an uncaught
    // rejection would have produced.
    check(
      'both demo sockets opened',
      false,
      err instanceof Event
        ? `${err.type} event on ${err.target?.url ?? 'unknown url'}`
        : String(err),
    )
    console.log(`\n${failures} CHECK(S) FAILED`)
    process.exit(1)
  }

  const welcome = await a.expect('welcome')
  check(
    'demo socket is welcomed, placed, and told the radius it is matching in',
    typeof welcome.cell === 'string' &&
      welcome.cell.length > 0 &&
      Number.isFinite(welcome.position?.lat) &&
      welcome.radiusMeters > 0,
    `${welcome.cell} ${JSON.stringify(welcome.position)} ${welcome.radiusMeters}m`,
  )
  const welcomeB = await b.expect('welcome')
  check(
    'welcome carries a demo identity',
    typeof welcome.user?.id === 'string' && welcome.user.id.startsWith('demo:'),
    JSON.stringify(welcome.user),
  )
  check(
    'the two sides are two identities, and each is its own cookie',
    welcome.user.id !== welcomeB.user.id &&
      jarA.endsWith(welcome.user.id.slice('demo:'.length)) &&
      jarB.endsWith(welcomeB.user.id.slice('demo:'.length)),
    `${welcome.user.id} / ${welcomeB.user.id}`,
  )
  check(
    'the position came from the server, with no coordinates and no prompt',
    welcome.locationSource === 'edge' || welcome.locationSource === 'demo',
    `${welcome.locationSource} — 'edge' from request.cf, 'demo' when there is none to read`,
  )

  a.join()
  await a.expect('waiting')

  // --- a second tab of one browser is one buyer, and is told so (#101) ---
  // The cost the operator accepted, exercised rather than described: the same
  // cookie is the same person, so this socket cannot queue beside the one it is
  // sharing an identity with, and it is told which tab it is already in.
  const sameBrowser = open('Robb', jarA)
  await sameBrowser.opened
  const sameBrowserWelcome = await sameBrowser.expect('welcome')
  check(
    'a second tab of one browser is the same identity, not a new one',
    sameBrowserWelcome.user?.id === welcome.user.id,
    `${sameBrowserWelcome.user?.id} vs ${welcome.user.id}`,
  )
  sameBrowser.join()
  const refused = await sameBrowser.expect('error')
  check(
    'a second tab is refused while the first is queued, with a message saying which tab',
    refused.code === 'already_waiting' && /another tab or window/i.test(refused.message ?? ''),
    `${refused.code}: ${refused.message}`,
  )
  check(
    'and takes no seat at all',
    (await sameBrowser.settles('waiting')) === false,
    JSON.stringify(sameBrowser.inbox.map((m) => m.type)),
  )
  sameBrowser.ws.close()

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

  // --- a demo pair is never charged ---
  // The ledger already refuses to book a demo split (below). This is the other
  // half of the same rule, and the half that costs real money if it breaks: a
  // throwaway `demo:` identity must never reach Stripe at all, not even on a
  // fully configured production deploy. `paymentDisposition` answers `demo`
  // before it looks at the secrets, so the tell is that the pickup code is
  // released at match time and nobody is asked to pay.
  //
  // The CI job that runs this points `STRIPE_API_BASE` at an address nothing is
  // listening on, so a demo pair that *did* try to charge would abort the match
  // rather than quietly succeed — which is what makes these two assertions
  // enforcement rather than decoration.
  await new Promise((resolve) => setTimeout(resolve, 800))
  check(
    'a demo pair is never asked to pay',
    [a, b].every((s) => s.inbox.every((m) => m.type !== 'payment_required')),
    JSON.stringify([a, b].map((s) => s.inbox.map((m) => m.type))),
  )
  check(
    'a demo pair gets its pickup code at match time, because no money is in play',
    typeof ma.pickupCode === 'string' && ma.pickupCode.length === 6,
    `${ma.pickupCode}`,
  )
  check('and the receiver still never gets it', mb.pickupCode === null, `${mb.pickupCode}`)

  // --- the native-camera path, at the protocol level (#101) ---
  // A phone's own camera app opens the handoff link in a NEW TAB, which is a new
  // socket. This is what has to happen on that socket: the server recognises the
  // cookie as the same buyer and seats it in the live match, as the same role,
  // with no `join` sent and nothing confirmed. Without the sticky identity it
  // would arrive as a stranger the match has never heard of, which is the whole
  // reason the cookie exists.
  const scannerTab = open('Dana', jarB)
  await scannerTab.opened
  const scannerWelcome = await scannerTab.expect('welcome')
  check(
    'a new tab of the receiver’s browser is the same identity',
    scannerWelcome.user?.id === welcomeB.user.id,
    `${scannerWelcome.user?.id} vs ${welcomeB.user.id}`,
  )
  const adopted = await scannerTab.expect('matched')
  check(
    'and is seated in the same live match, without sending a join',
    adopted.matchId === ma.matchId && adopted.role === 'receiver',
    `${adopted.matchId} as ${adopted.role}`,
  )
  check(
    'the receiver’s second tab is still never handed the code',
    adopted.pickupCode === null,
    `${adopted.pickupCode}`,
  )
  check(
    'and opening it confirmed nothing on its own',
    (await scannerTab.settles('pickup_confirmed')) === false &&
      [a, b].every((s) => s.inbox.every((m) => m.type !== 'pickup_confirmed')),
    JSON.stringify([a, b].map((s) => s.inbox.map((m) => m.type))),
  )
  // And closing it does not tear the match down: a match is abandoned only when
  // the last socket on that side goes.
  scannerTab.ws.close()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    'closing the tab the link opened leaves the match alone',
    [a, b].every((s) => s.inbox.every((m) => m.type !== 'buddy_left')),
    JSON.stringify([a, b].map((s) => s.inbox.map((m) => m.type))),
  )

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

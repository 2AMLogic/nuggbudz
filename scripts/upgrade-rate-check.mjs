#!/usr/bin/env node
/**
 * The upgrade limiter's refusal is reachable off the wire (#105).
 *
 * `worker/index.ts` answers a tripped `checkUpgradeRate` with a 429 — but a
 * browser handed a non-101 response from a `WebSocket` constructor never sees
 * that body, it only fires `close`. Nobody saw this the cheap way: #104's
 * suites opened more upgrades than a local dev server's shared `unknown`
 * bucket allows, and every one of them read as "Lost the connection. Try
 * again." rather than as a refusal with a wait attached. `pnpm test` cannot
 * catch it — `checkUpgradeRate` itself was never wrong, only unreachable from
 * a refused socket — so this drives the real Worker the way a browser does.
 *
 * Two things are asserted, both against real WebSocket upgrade attempts, not
 * a bare call to the rate-limiting function:
 *
 *   - the attempt that goes over the limit is actually refused (its socket
 *     never reaches `open`), proving the limiter is wired to the real upgrade
 *     path and not just correct in isolation;
 *   - a plain `fetch` at the exact same URL — `usePool`'s probe, run when a
 *     socket closes before it ever opens — gets the 429 back, with
 *     `Retry-After` and a body naming the problem. That plain GET carries no
 *     `Upgrade` header, so it also proves the rate check in `worker/index.ts`
 *     runs *before* the `Upgrade` header is even inspected (#105) — the one
 *     thing that makes the probe able to find the refusal underneath it
 *     rather than a generic 426.
 *
 * Needs a dev server with a small anonymous upgrade window — the production
 * default (20 a minute, wrangler.jsonc) would need dozens of sockets from one
 * process to trip. Usage:
 *
 *   echo 'POOL_ANON_UPGRADE_LIMIT="2"' >> .dev.vars
 *   pnpm dev --port 5199                                  (one shell)
 *   BASE=http://localhost:5199 pnpm upgrade-rate-check    (another)
 */
const BASE = process.env.BASE ?? 'http://localhost:5199'
const WS = BASE.replace('http', 'ws')
// Must match the server's `POOL_ANON_UPGRADE_LIMIT` (or its default, 20) —
// exported as an env var rather than hardcoded so CI's `.dev.vars` and this
// script cannot drift apart silently.
const LIMIT = Number.parseInt(process.env.EXPECTED_ANON_UPGRADE_LIMIT ?? '2', 10)

const log = (...a) => console.log(...a)
let failures = 0
const check = (name, ok, extra = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

/**
 * Open an anonymous pool socket (no session cookie, so this counts against the
 * `anonymous` bucket) and report whether the upgrade completed.
 *
 * A refused attempt is not recorded in the limiter's own window (see
 * `slidingWindow`'s doc comment), so these never need to be undone — only the
 * `LIMIT + 1`th attempt here is expected to go over.
 */
function attemptUpgrade() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/api/pool/ws`)
    let opened = false
    ws.addEventListener('open', () => {
      opened = true
      ws.close()
    })
    ws.addEventListener('close', () => resolve(opened))
    // A refused upgrade fires `error` too; `close` always follows it, so the
    // outcome is read there either way.
    ws.addEventListener('error', () => {})
    setTimeout(() => resolve(opened), 4_000)
  })
}

const opens = []
for (let i = 0; i < LIMIT; i++) {
  opens.push(await attemptUpgrade())
}
check(
  `the first ${LIMIT} anonymous upgrades are let through`,
  opens.every(Boolean),
  JSON.stringify(opens),
)

const overTheLimit = await attemptUpgrade()
check('an upgrade past the limit is refused, not merely slow', overTheLimit === false)

// The probe `usePool` makes when a socket closes before it ever opens: the
// exact same URL, over plain HTTP, with no `Upgrade` header at all.
const probe = await fetch(`${BASE}/api/pool/ws`)
check('the probe gets the 429 back', probe.status === 429, `status ${probe.status}`)

const retryAfterHeader = probe.headers.get('Retry-After')
const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '', 10)
check(
  'Retry-After is a positive whole number of seconds',
  Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0,
  `Retry-After: ${retryAfterHeader}`,
)

const body = await probe.json().catch(() => null)
check(
  'the body names the problem rather than reading as a generic failure',
  typeof body?.error === 'string' && /too many connection attempts/i.test(body.error),
  JSON.stringify(body),
)
check(
  'the body also carries retryAfterSeconds, for a client that cannot read headers',
  body?.retryAfterSeconds === retryAfterSeconds,
  JSON.stringify(body),
)

// The thing a buyer actually sees: `usePool`'s own message-building logic,
// run here against the real server's answer rather than trusted blind. See
// `probeUpgradeRefusal` in `src/hooks/usePool.ts`.
const clientMessage =
  Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? `Too many connection attempts — try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`
    : 'Too many connection attempts — slow down and try again.'
check(
  'what the client would show says "too many", never "lost the connection"',
  /too many/i.test(clientMessage) && !/lost the connection/i.test(clientMessage),
  clientMessage,
)

if (failures > 0) {
  log(`\n${failures} check(s) failed.`)
  process.exit(1)
}
log('\nAll upgrade rate-limit checks passed.')

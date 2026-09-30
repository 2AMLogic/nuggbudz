/**
 * Demo pairing — the escape hatch that keeps a live demo alive.
 *
 * A seat requires a signed-in account, which is right for production and fatal
 * on a conference stage: Google sign-in needs configured credentials, a
 * round-trip to Google, and a consent screen on a borrowed phone. Every
 * unauthenticated caller is given a throwaway identity — since #150 a signed-out
 * browser may always *look* at the market — and when `ALLOW_DEMO_PAIRING` is
 * set, that identity may also take a seat, so two phones can still pair. The
 * flag answers that one question, in one place: `seatVerdict` in
 * `shared/identity.ts`, on the pool's `join` path.
 *
 * That identity is **per browser, not per socket** (#101). It has to be: the
 * pickup QR now carries a link, a phone's own camera app opens that link in a new
 * tab, and a new tab is a new socket — so an identity minted at upgrade time
 * would arrive at the handoff as a stranger who is not in the match. The cookie
 * below is what makes the scanner the same person. The accepted cost, chosen
 * deliberately rather than discovered: two tabs on one laptop are now one buyer,
 * the self-match guard refuses to pair them, and a single-device demo no longer
 * works. Pairing needs two devices.
 *
 * This is deliberately OFF by default and never set in `wrangler.jsonc` — it is
 * passed at deploy time (`wrangler deploy --var ALLOW_DEMO_PAIRING:1`), so a
 * checkout, a test run and CI all exercise the strict path and no `vite build`
 * can bake an auth bypass into a production artifact by accident. This mirrors
 * the reasoning 311alarm applies to its dev-OTP flag.
 *
 * `wrangler dev --var` is a different lever and does not reliably work: on the
 * currently pinned wrangler version (confirmed on 4.142.0, macOS arm64) it lists
 * the binding in the startup table but the Worker sees this env var as
 * `undefined` at runtime (#37). Not load-bearing here either way — local dev
 * runs through `pnpm dev` (`vite dev`), not `wrangler dev` — so `.dev.vars` is
 * the only mechanism to trust locally; see README.md's "Demo pairing" section.
 */
import { parseCookies } from './auth'
import { sanitizeDisplayText } from './text'

/** Truthy spellings an operator might plausibly pass to a Worker var. */
export function demoPairingEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    default:
      return false
  }
}

/** Longest display name a buddy card can show without wrapping badly. */
const MAX_NAME = 40

/**
 * Clean a demo-supplied name into something safe to show a stranger.
 *
 * An unauthenticated caller chooses this string, so it is untrusted input:
 * control characters stripped, whitespace collapsed, length-capped, never empty.
 *
 * The cleaning itself lives in `shared/text.ts` because Nuggchat needs exactly
 * the same treatment for exactly the same reason, and two copies of a sanitizer
 * this heavily iterated on would drift. Everything this function still owns is
 * the *name* policy: the cap, and the fallback when nothing survives.
 */
export function sanitizeDemoName(raw: string | null | undefined): string {
  const cleaned = sanitizeDisplayText(raw, MAX_NAME)
  return cleaned.length === 0 ? 'Guest' : cleaned
}

/** The marker that makes a demo identity greppable, spelled once. */
export const DEMO_USER_ID_PREFIX = 'demo:'

/**
 * A throwaway user id for a demo buyer.
 *
 * Prefixed so a demo identity is legible as one at a glance — in the ledger
 * gate, in logs, in a reputation count — and trivially greppable. `unique` is
 * the browser's demo cookie token where there is one, so the id is stable across
 * that browser's tabs and sockets.
 */
export function demoUserId(unique: string): string {
  return `${DEMO_USER_ID_PREFIX}${unique}`
}

/**
 * True when this id was minted by demo pairing rather than a real sign-in.
 *
 * What this guarantees, precisely: an id carrying the prefix *is* a demo
 * identity, so the ledger can exclude it. It says nothing about the ids it
 * answers `false` for — `''` is not a demo id and is not a real account either.
 * Deciding that an id is genuinely an account, which is what lets money be
 * booked against it, is `classifyUserId` in `shared/identity.ts`; this predicate
 * is only one of its three answers.
 */
export function isDemoUserId(userId: string): boolean {
  return userId.startsWith(DEMO_USER_ID_PREFIX)
}

/**
 * The cookie that makes a demo identity stick to a browser.
 *
 * Named apart from `nb_session` on purpose: a session is an account, this is a
 * throwaway, and the two must never be confused by a reader or by a parser.
 */
export const DEMO_COOKIE = 'nb_demo'

/**
 * 32 random bytes rendered base64url: 43 characters, no padding — the same
 * shape and the same entropy as a session id, for the same reason. A demo
 * identity books nothing, but it can adopt a live match (`worker/pool.ts`), so
 * guessing somebody else's is worth making as hard as guessing a session.
 */
export const DEMO_TOKEN_LENGTH = 43

/**
 * How long a demo identity lives. A day: long enough that a phone set down
 * between the queue and the counter is still the same buyer, short enough that a
 * borrowed handset does not carry a stranger's identity into next week.
 */
export const DEMO_TTL_SECONDS = 60 * 60 * 24

/**
 * Is this a token this server could have minted?
 *
 * Checked before the value is ever spliced into a user id, because
 * `demo:<anything>` is what `classifyUserId` answers `demo` to — and a user id is
 * a string that reaches the ledger gate, the logs and the match record. A cookie
 * is attacker-controlled, so the shape is the boundary.
 */
export function isDemoTokenShaped(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length === DEMO_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(raw)
}

/**
 * The demo identity cookie.
 *
 * `HttpOnly` keeps it away from script and `SameSite=Lax` is load-bearing rather
 * than conventional: opening the handoff link from a phone's camera app is a
 * top-level navigation, which `Lax` allows and `Strict` would drop — dropping it
 * is exactly the failure this cookie exists to prevent.
 *
 * `Secure` is a parameter rather than always-on, unlike `sessionCookie`. A
 * session is only ever minted at the end of an OAuth redirect, which is https by
 * construction; a demo identity is minted on an ordinary request to whatever
 * origin is serving the app, and demo mode's whole purpose is a stage or a
 * laptop where that origin is `http://localhost`. A `Secure` cookie there is a
 * cookie the browser never sends back, which is silently the same as having no
 * sticky identity at all.
 */
export function demoCookie(
  token: string,
  options: { secure: boolean; maxAgeSeconds?: number },
): string {
  const parts = [
    `${DEMO_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${options.maxAgeSeconds ?? DEMO_TTL_SECONDS}`,
    'HttpOnly',
  ]
  if (options.secure) parts.push('Secure')
  parts.push('SameSite=Lax')
  return parts.join('; ')
}

/** The demo token on a request, or null when there is not a usable one. */
export function demoTokenFromCookieHeader(header: string | null | undefined): string | null {
  const value = parseCookies(header)[DEMO_COOKIE]
  return isDemoTokenShaped(value) ? value : null
}

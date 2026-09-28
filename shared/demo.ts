/**
 * Demo pairing — the escape hatch that keeps a live demo alive.
 *
 * Pairing requires a signed-in account, which is right for production and fatal
 * on a conference stage: Google sign-in needs configured credentials, a
 * round-trip to Google, and a consent screen on a borrowed phone. When
 * `ALLOW_DEMO_PAIRING` is set, the Worker instead mints a throwaway identity for
 * an unauthenticated socket, so two phones can still pair.
 *
 * This is deliberately OFF by default and never set in `wrangler.jsonc` — it is
 * passed at deploy time (`wrangler deploy --var ALLOW_DEMO_PAIRING:1`), so a
 * checkout, a test run and CI all exercise the strict path and no `vite build`
 * can bake an auth bypass into a production artifact by accident. This mirrors
 * the reasoning 311alarm applies to its dev-OTP flag.
 */
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
 * A throwaway user id for a demo socket.
 *
 * Prefixed so a demo identity is legible as one at a glance — in the ledger
 * gate, in logs, in a reputation count — and trivially greppable.
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

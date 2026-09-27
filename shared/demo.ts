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

/** Space, the lowest printable code point. Anything below it is a control char. */
const FIRST_PRINTABLE = 0x20
const DELETE_CHAR = 0x7f

/**
 * Clean a demo-supplied name into something safe to show a stranger.
 *
 * An unauthenticated caller chooses this string, so it is untrusted input:
 * control characters stripped, whitespace collapsed, length-capped, never empty.
 */
export function sanitizeDemoName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'Guest'
  // Whitespace first, control characters second. A newline or tab is whitespace
  // that happens to sit below the printable range, so deleting it before this
  // step would glue two words together ('Robb\nWalters' -> 'RobbWalters')
  // instead of separating them.
  const spaced = raw.replace(/\s/g, ' ')
  const printable = Array.from(spaced)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= FIRST_PRINTABLE && code !== DELETE_CHAR
    })
    .join('')
  const cleaned = printable.replace(/ +/g, ' ').trim()
  if (cleaned.length === 0) return 'Guest'
  return cleaned.slice(0, MAX_NAME)
}

/**
 * A throwaway user id for a demo socket.
 *
 * Prefixed so a demo identity is never mistaken for a real account in the
 * ledger, in logs or in a reputation count, and so one is trivially greppable.
 */
export function demoUserId(unique: string): string {
  return `demo:${unique}`
}

/** True when this id was minted by demo pairing rather than a real sign-in. */
export function isDemoUserId(userId: string): boolean {
  return userId.startsWith('demo:')
}

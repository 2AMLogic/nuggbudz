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

/**
 * Every invisible character a buddy card must never receive.
 *
 * - `\p{Cc}` is the control range: C0 (U+0000–U+001F), DEL, **and** C1
 *   (U+0080–U+009F). C1 is the gap a hand-rolled `code >= 0x20` check left open
 *   — JS `\s` does not match U+0085 NEL either, so it used to reach the card as
 *   an invisible byte inside an otherwise ordinary-looking name.
 * - `\p{Cf}` is the format range: U+200B zero-width space, and the bidi
 *   overrides (U+202E RLO) that let a name render in an order its stored bytes
 *   do not have. That reordering is the one real display-spoofing primitive
 *   available to an unauthenticated demo caller.
 * - `\p{Cs}` is the lone surrogates, which decode to U+FFFD wherever they land.
 *
 * Dropping the whole `Cf` range also splits a ZWJ emoji sequence into its
 * components (a family emoji becomes three glyphs). That is a rendering
 * downgrade on a throwaway demo name, and a cheap price for a card that is
 * guaranteed to hold no invisible characters at all.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu

/**
 * Cap a name at `limit` user-perceived characters.
 *
 * `slice` counts UTF-16 code units, so cutting at 40 units lands mid-pair when
 * the 40th unit happens to open an emoji's surrogate pair, leaving a lone
 * surrogate that decodes to U+FFFD. Segment first, then rejoin whole units.
 * `Intl.Segmenter` additionally keeps a combining mark attached to its base
 * letter; where it is unavailable we cap by code point, which is coarser but
 * still never cuts a pair in half.
 */
function capToLength(value: string, limit: number): string {
  const units =
    typeof Intl.Segmenter === 'function'
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
          (entry) => entry.segment,
        )
      : Array.from(value)
  return units.slice(0, limit).join('')
}

/**
 * Clean a demo-supplied name into something safe to show a stranger.
 *
 * An unauthenticated caller chooses this string, so it is untrusted input:
 * control, format and surrogate characters stripped, whitespace collapsed,
 * length-capped by grapheme, never empty.
 */
export function sanitizeDemoName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'Guest'
  // Whitespace first, invisibles second. A newline or tab is whitespace that
  // happens to sit inside the C0 control range, so deleting it before this step
  // would glue two words together ('Robb\nWalters' -> 'RobbWalters') instead of
  // separating them. This ordering is load-bearing and pinned by a test.
  const spaced = raw.replace(/\s/gu, ' ')
  const cleaned = spaced.replace(INVISIBLE, '').replace(/ +/g, ' ').trim()
  // Trim after capping too: the cap can otherwise end the name on the space
  // that used to separate two words.
  const capped = capToLength(cleaned, MAX_NAME).trim()
  return capped.length === 0 ? 'Guest' : capped
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

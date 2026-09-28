/**
 * The handoff link: the pickup code as something a phone's own camera can open.
 *
 * #92 encoded the bare code and argued that a URL was a payload-minimalism
 * mistake, because a QR on a phone screen in a queue is photographable by
 * everyone behind you. The first half of that is true and the conclusion did not
 * follow (#101): **the pickup code was never secret from somebody standing next
 * to you.** What protects the handoff is server-side identity — `confirm_pickup`
 * arrives on an authenticated socket, and the server refuses anyone who is not
 * the receiver of that match. Minimalism bought nothing and cost the one path a
 * borrowed phone actually has: its own camera app.
 *
 * So the symbol carries a link. Three rules hold it in shape:
 *
 * - **It is a hand-off, never a confirmation.** Opening this URL gives the code
 *   to the session that opened it and nothing else. That session still taps, and
 *   the server still checks it is the receiver of that match. A link that settled
 *   money when opened is a link a bystander can photograph across a table and tap
 *   from their seat.
 * - **It reads as a code even when it carries nobody.** A phone that lands here
 *   without being in the match still shows six characters big enough to read
 *   aloud, so failing to carry identity degrades to the typed path rather than to
 *   a dead end.
 * - **It is as short as a URL can be.** Every character is modules, and at
 *   error-correction level H a denser symbol is harder to read at arm's length
 *   across a table. See `qrPayloadFor` below for the one trick that is worth
 *   having here.
 *
 * Runtime-free like the rest of `shared/`: this is string work over untrusted
 * input — a path off `window.location`, a payload off a camera — and both the
 * Worker and the client need the same answer.
 */
import { isPickupCode, normalizePickupCode } from './pickup'

/**
 * The path a scanned code lands on. One character, because it is 8 modules'
 * worth of QR before anything useful is in the symbol.
 *
 * Matched case-insensitively everywhere it is read, because `qrPayloadFor`
 * upper-cases the whole URL.
 */
export const HANDOFF_SEGMENT = 'h'

/** `/h/` — spelled once, from the segment above. */
export const HANDOFF_PATH_PREFIX = `/${HANDOFF_SEGMENT}/`

/** True when this path is a handoff link, whatever case it arrived in. */
export function isHandoffPath(pathname: string): boolean {
  return pickupCodeFromPath(pathname) !== null
}

/**
 * The code carried by a path, or null.
 *
 * Strict about the shape: exactly `/h/<code>`, nothing after it, and the code
 * has to be a real pickup code. A path that is nearly right is not a code with a
 * typo, it is somebody else's URL.
 */
export function pickupCodeFromPath(pathname: string): string | null {
  if (typeof pathname !== 'string') return null
  const segments = pathname.split('/').filter((part) => part.length > 0)
  if (segments.length !== 2) return null
  if (segments[0].toLowerCase() !== HANDOFF_SEGMENT) return null
  const code = normalizePickupCode(segments[1])
  return isPickupCode(code) ? code : null
}

/**
 * The link for a code, against an origin.
 *
 * Takes the code and the origin separately rather than a ready-made string, so
 * there is no call site at which something else could be smuggled into the
 * symbol — the same reasoning `pickupQrMatrix` applies, and this is where it is
 * enforced for the URL half.
 */
export function handoffUrl(origin: string, code: string): string {
  if (!isPickupCode(code)) {
    throw new Error('refusing to build a handoff link for a value that is not a pickup code')
  }
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`handoff origin is not a URL: ${origin}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`handoff origin is not http(s): ${origin}`)
  }
  return `${parsed.origin}${HANDOFF_PATH_PREFIX}${code}`
}

/**
 * The same link, upper-cased for the symbol.
 *
 * This is the one payload trick worth having. QR's *alphanumeric* mode spends 11
 * bits per two characters where byte mode spends 8 per one, but its charset is
 * digits, upper-case letters and ``$%*+-./:`` — no lower case. A URL's scheme and
 * host are case-insensitive by RFC 3986, the path here is matched
 * case-insensitively by `pickupCodeFromPath`, and a pickup code is upper-case
 * already. So upper-casing costs nothing and buys a whole version or two:
 * `https://nuggbudz.com/h/ABC123` is a 33-module symbol in byte mode and a
 * **29-module** one like this. (The bare code was 21. Measured in
 * `test/handoff.test.ts`, not asserted from this comment.)
 *
 * Dropping the scheme would shorten the string by eight characters and buy
 * nothing at all — 21 characters and 29 characters land in the same version-3
 * symbol — while making it a guess whether a camera app linkifies it. So the
 * scheme stays.
 */
export function qrPayloadFor(origin: string, code: string): string {
  return handoffUrl(origin, code).toUpperCase()
}

/**
 * The pickup code inside anything a camera just read, or null.
 *
 * Accepts **both** payload forms, because a receiver scanning in-app must not
 * care which one they got: a receipt printed by an older client carries a bare
 * code, and one printed by this client carries a link. Everything else — a
 * merchant's promo QR, a wifi card taped to the counter, a link to this app's
 * home page — is null, which is how the scanner knows to keep looking.
 */
export function pickupCodeFromScan(raw: string): string | null {
  if (typeof raw !== 'string') return null

  // The URL form first: `normalizePickupCode` would happily strip a whole URL
  // down to letters and digits, and `HTTPSNUGGBUDZCOMHABC123` is not six
  // characters, but relying on that accident would be a poor way to say so.
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // A code in a query string or a fragment is not this link, and neither is a
    // link that carries anything besides the code.
    if (parsed.search.length > 0 || parsed.hash.length > 0) return null
    return pickupCodeFromPath(parsed.pathname)
  } catch {
    // Not a URL at all: the bare-code form.
  }

  const code = normalizePickupCode(raw)
  return isPickupCode(code) ? code : null
}

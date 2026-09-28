/**
 * The pickup code as a QR symbol.
 *
 * The payload is a **handoff link for the pickup code** — `shared/handoff.ts`
 * builds it — and nothing else: no match id, no user id, no session token, no
 * free text. `pickupQrMatrix` takes a code and an origin rather than a
 * ready-made string, so there is no call site at which something else could be
 * smuggled in, which is the same guarantee #92 got from refusing anything that
 * was not a bare code.
 *
 * Why a link at all, when #92 argued for the bare code: a QR held up in a queue
 * is photographable by everybody standing behind you, so whatever is in it is
 * public to the room — and the pickup code always was. What protects the handoff
 * is server-side identity, not payload minimalism (see `shared/handoff.ts`). The
 * link is worth its extra modules because it is the only path a borrowed phone
 * has without the app: the native camera shows a tappable `nuggbudz.com/h/K7M2QX`,
 * and even when it carries nobody into the match, **the code is readable right
 * off it**.
 *
 * Runtime-free like the rest of `shared/`: a module matrix is a pure function of
 * a code and an origin, so the round trip that actually matters — encode,
 * rasterize, decode, get the same six characters back — is testable with no
 * camera, no canvas and no browser.
 */
import qrcode from 'qrcode-generator'
import { qrPayloadFor } from './handoff'
import { isPickupCode, PICKUP_CODE_LENGTH } from './pickup'

/**
 * Let the encoder pick the smallest version that fits.
 *
 * #92 pinned version 1, and could: a six-character payload fits the smallest
 * symbol there is even at level H. A link cannot be pinned, because the symbol it
 * needs depends on how long the deployment's own hostname is — `nuggbudz.com`
 * lands in version 3 and the `*.workers.dev` name in version 5. A pinned version
 * would mean a deploy whose receipt throws rather than one whose symbol is a
 * little denser, so the number is derived and `test/handoff.test.ts` measures
 * what it actually costs.
 */
export const QR_TYPE_AUTO = 0

/**
 * Level H: ~30% of the symbol can be obscured and it still decodes.
 *
 * Kept from #92 even though the payload grew, and deliberately. The budget is
 * spent on the conditions this thing is used in — a fingerprint, a glare band, a
 * cracked screen — and those do not get gentler because the URL is longer.
 */
export const QR_ERROR_CORRECTION = 'H'

/** The blank margin the QR spec requires around a symbol, in modules. */
export const QR_QUIET_ZONE_MODULES = 4

/**
 * QR's alphanumeric charset: digits, upper-case letters, and nine punctuation
 * marks. Spelled out because the mode choice below turns on it.
 */
const QR_ALPHANUMERIC = new Set(`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:`)

/**
 * Alphanumeric mode where the payload allows it, byte mode otherwise.
 *
 * Alphanumeric spends 11 bits per two characters where byte spends 8 per one, so
 * it is worth a whole version or two on a payload this size —
 * `HTTPS://NUGGBUDZ.COM/H/K7M2QX` is 29 modules where the same URL in byte mode
 * is 33. `qrPayloadFor` upper-cases the URL precisely so this branch is the one
 * taken; the fallback exists because a hostname is not guaranteed to be
 * spellable in that charset (an IDN's punycode is, an unusual one may not be),
 * and a slightly denser symbol is a much better answer than a receipt that
 * throws.
 */
function modeFor(payload: string): 'Alphanumeric' | 'Byte' {
  return Array.from(payload).every((char) => QR_ALPHANUMERIC.has(char)) ? 'Alphanumeric' : 'Byte'
}

/**
 * The symbol for a pickup code, row-major, `true` where a module is dark.
 *
 * Excludes the quiet zone: a renderer has to know how much blank margin it is
 * drawing, and a matrix padded with falsy rows cannot be told apart from a
 * symbol that happens to start pale.
 *
 * `origin` is where the link points — `window.location.origin` on the client, so
 * a preview deploy prints a link back to itself rather than to production.
 */
export function pickupQrMatrix(code: string, origin: string): boolean[][] {
  if (!isPickupCode(code)) {
    // Not a defensive nicety. This is the check that keeps the payload honest:
    // the only thing that can be encoded is a link built from a thing shaped
    // exactly like a pickup code, so no caller can widen this into a match id or
    // a session token later.
    throw new Error(
      `refusing to encode a ${PICKUP_CODE_LENGTH}-character pickup code from a value that is not one`,
    )
  }
  const payload = qrPayloadFor(origin, code)
  const symbol = qrcode(QR_TYPE_AUTO, QR_ERROR_CORRECTION)
  symbol.addData(payload, modeFor(payload))
  symbol.make()
  const count = symbol.getModuleCount()
  const rows: boolean[][] = []
  for (let row = 0; row < count; row += 1) {
    const cells: boolean[] = []
    for (let column = 0; column < count; column += 1) cells.push(symbol.isDark(row, column))
    rows.push(cells)
  }
  return rows
}

/** How many modules wide a rendered symbol is, quiet zone included. */
export function qrSpanModules(matrix: boolean[][]): number {
  return matrix.length + QR_QUIET_ZONE_MODULES * 2
}

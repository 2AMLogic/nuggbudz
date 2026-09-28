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

/**
 * How many modules wide a rendered symbol is, **quiet zone included**.
 *
 * The distinction is load-bearing and has been got wrong once already (#127):
 * `matrix.length` is the *data area* — 29 modules for `nuggbudz.com`, 37 for a
 * `*.workers.dev` name — and this function is that plus the four-module margin on
 * each side, so 37 and 45. Size a canvas off the data area and the symbol is
 * eight modules wider than the space reserved for it; that is how a 296 px symbol
 * came to be described as a 232 px one.
 */
export function qrSpanModules(matrix: boolean[][]): number {
  return matrix.length + QR_QUIET_ZONE_MODULES * 2
}

/**
 * Pixels per module a receipt draws at when it has the room.
 *
 * Generous on purpose: this symbol is read off a screen by a stranger's phone, at
 * an angle, through a fingerprint, and the error-correction budget is spent on
 * those conditions rather than on being small.
 */
export const QR_MODULE_PIXELS_MAX = 8

/**
 * The narrowest pitch worth drawing at, rather than letting CSS resample.
 *
 * A browser's own downscale is the worse of the two failures: it lands module
 * edges on fractional pixels, which is the moiré a decoder has to hunt through,
 * and it is invisible in any test that reads the canvas's backing store. Four
 * pixels per module is comfortably above what `jsQR` needs, and `qrModulePixels`
 * should never have to reach for it — the narrowest screen in use is 320 CSS px,
 * whose receipt column is wider than 45 × 4.
 */
export const QR_MODULE_PIXELS_MIN = 4

/**
 * The widest whole-pixel module pitch whose symbol fits `availablePixels`.
 *
 * **`spanModules` is `qrSpanModules`, which includes the quiet zone** — pass the
 * bare `matrix.length` and this hands back a pitch eight modules too generous.
 * That is the arithmetic #127 was filed for: at a fixed pitch of 8 the longest
 * deployed origin needs 45 × 8 = 360 px, which no 320 px phone has, so a single
 * pitch cannot both fill a desktop column and fit a phone. The pitch has to be
 * derived from the space that actually exists.
 *
 * Whole pixels, because a fractional pitch is a resample under another name. The
 * result is clamped rather than allowed to collapse, so a container that has not
 * been measured yet still gets a drawable symbol.
 */
export function qrModulePixels(spanModules: number, availablePixels: number): number {
  if (!Number.isFinite(availablePixels) || spanModules <= 0) return QR_MODULE_PIXELS_MAX
  const fits = Math.floor(availablePixels / spanModules)
  return Math.min(QR_MODULE_PIXELS_MAX, Math.max(QR_MODULE_PIXELS_MIN, fits))
}

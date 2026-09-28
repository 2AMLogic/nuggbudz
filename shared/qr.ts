/**
 * The pickup code as a QR symbol.
 *
 * The payload is the pickup code and nothing else — no match id, no user id, no
 * session token, no URL. A QR held up in a queue is photographable by everybody
 * standing behind you, so whatever is in it is public to the room; the code
 * alone is scoped to one match and worthless without the other side's
 * confirmation. `pickupQrMatrix` refuses anything that is not a pickup code, so
 * there is no call site at which something else could be smuggled in.
 *
 * Runtime-free like the rest of `shared/`: a module matrix is a pure function of
 * six characters, so the round trip that actually matters — encode, rasterize,
 * decode, get the same six characters back — is testable with no camera, no
 * canvas and no browser.
 */
import qrcode from 'qrcode-generator'
import { isPickupCode, PICKUP_CODE_LENGTH } from './pickup'

/**
 * Version 1: a 21x21 symbol, the smallest there is.
 *
 * A six-character pickup code in alphanumeric mode fits version 1 even at the
 * heaviest error correction, and a small symbol has large modules at any given
 * on-screen size — which is the whole of what makes it scannable across a table.
 */
export const QR_TYPE_NUMBER = 1

/**
 * Level H: ~30% of the symbol can be obscured and it still decodes.
 *
 * Free here, because the payload is short enough that the next level down would
 * not shrink the symbol. The budget is spent on the conditions this thing is
 * actually used in: a fingerprint, a glare band, a cracked screen.
 */
export const QR_ERROR_CORRECTION = 'H'

/** The blank margin the QR spec requires around a symbol, in modules. */
export const QR_QUIET_ZONE_MODULES = 4

/**
 * Alphanumeric mode, not byte mode.
 *
 * `PICKUP_CODE_ALPHABET` is a subset of QR's alphanumeric charset (digits and
 * upper-case letters), and alphanumeric mode spends 11 bits per two characters
 * where byte mode spends 8 per one — which is what keeps a level-H code inside a
 * version 1 symbol.
 */
const QR_MODE = 'Alphanumeric'

/**
 * The symbol for a pickup code, row-major, `true` where a module is dark.
 *
 * Excludes the quiet zone: a renderer has to know how much blank margin it is
 * drawing, and a matrix padded with falsy rows cannot be told apart from a
 * symbol that happens to start pale.
 */
export function pickupQrMatrix(code: string): boolean[][] {
  if (!isPickupCode(code)) {
    // Not a defensive nicety. This is the check that keeps the payload honest:
    // the only thing that can be encoded is a thing shaped exactly like a pickup
    // code, so no caller can widen this into a URL or a match id later.
    throw new Error(
      `refusing to encode a ${PICKUP_CODE_LENGTH}-character pickup code from a value that is not one`,
    )
  }
  const symbol = qrcode(QR_TYPE_NUMBER, QR_ERROR_CORRECTION)
  symbol.addData(code, QR_MODE)
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

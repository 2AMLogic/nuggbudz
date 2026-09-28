import { pickupQrMatrix, QR_QUIET_ZONE_MODULES, qrSpanModules } from '@shared/qr'
import { useEffect, useMemo, useRef } from 'react'

/**
 * Device pixels per module in the canvas backing store.
 *
 * The element is laid out at the same number of CSS pixels, so on a phone the
 * browser upscales by a whole device-pixel ratio and every module lands on a
 * pixel boundary. A fractional scale is what turns a QR into a moiré pattern.
 */
const MODULE_PIXELS = 8

/**
 * The pickup code as a QR the receiver can point a camera at.
 *
 * This replaces the decorative barcode that used to end the receipt, which said
 * so itself: "Not scannable, and not pretending to be." The code still travels
 * the way the protocol requires — the orderer holds it, the receiver can only get
 * it by standing in front of them — but through the air on a camera rather than
 * spelled out loud. Same trust, no new server surface.
 *
 * The symbol carries a **link** to that code (#101), not the bare code, so the
 * receiver does not need this app's scanner at all: their phone's own camera app
 * shows a tappable `nuggbudz.com/h/K7M2QX`, which either carries them into the
 * handoff or — failing that — simply shows them six characters to type. The
 * origin comes off this page rather than a constant, so a preview deploy prints
 * a link back to itself.
 *
 * Drawn to a canvas rather than an SVG so the pixels a scanner sees are readable
 * back out of the page, which is how `e2e/scan.spec.ts` feeds a real browser's
 * camera the orderer's real screen instead of a re-render of its own.
 */
export function PickupQr({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Pure and cheap, but it decides the element's attributes, so it has to be
  // known during render rather than in the effect that paints.
  const matrix = useMemo(() => pickupQrMatrix(value, window.location.origin), [value])
  const span = qrSpanModules(matrix) * MODULE_PIXELS

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return

    // Black on white, whichever way the roll is printed. The rest of this screen
    // inverts under `prefers-color-scheme: dark`, and an inverted QR is a symbol
    // a good half of scanners refuse: contrast here is a function, not a style.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, span, span)
    context.fillStyle = '#000000'
    for (const [row, cells] of matrix.entries()) {
      for (const [column, dark] of cells.entries()) {
        if (!dark) continue
        context.fillRect(
          (column + QR_QUIET_ZONE_MODULES) * MODULE_PIXELS,
          (row + QR_QUIET_ZONE_MODULES) * MODULE_PIXELS,
          MODULE_PIXELS,
          MODULE_PIXELS,
        )
      }
    }
  }, [matrix, span])

  return (
    <canvas
      ref={canvasRef}
      width={span}
      height={span}
      role="img"
      aria-label="Your pickup code as a QR code, for your bud to scan"
      className="mx-auto block border-2 border-hairline"
      // One CSS pixel per device pixel of the backing store, capped at the roll's
      // width on a narrow screen. Sized here rather than in a class because the
      // figure is derived from the symbol, not chosen.
      style={{ width: `${span}px`, height: 'auto', maxWidth: '100%' }}
    />
  )
}

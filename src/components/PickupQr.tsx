import { pickupQrMatrix, QR_QUIET_ZONE_MODULES, qrModulePixels, qrSpanModules } from '@shared/qr'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/**
 * The printed frame around the symbol, per side, in CSS pixels.
 *
 * Kept as a number rather than only in the `border-2` class because it is part of
 * the element's footprint: the column has to hold the symbol *and* this, so it
 * comes off the width before the module pitch is chosen.
 */
const FRAME_PIXELS = 2

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
 *
 * The module pitch is **measured, not fixed** (#127). How many modules the symbol
 * has depends on how long the deployment's own hostname is — `qrSpanModules` is 37
 * on `nuggbudz.com` and 45 on a `*.workers.dev` preview name, quiet zone included
 * — and 45 modules at the old fixed 8 px is 360 px, which does not fit a 320 px
 * phone at any padding. So the column is measured and the pitch derived from it,
 * which keeps one CSS pixel per backing pixel on every screen instead of handing
 * the browser a fractional downscale nobody can see from the backing store.
 */
export function PickupQr({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  // Pure and cheap, but it decides the element's attributes, so it has to be
  // known during render rather than in the effect that paints.
  const matrix = useMemo(() => pickupQrMatrix(value, window.location.origin), [value])
  const spanModules = qrSpanModules(matrix)
  // Null until the column has been measured, which is one layout pass away — not
  // one paint, see the layout effect below.
  const [columnPixels, setColumnPixels] = useState<number | null>(null)
  const modulePixels =
    columnPixels === null ? 0 : qrModulePixels(spanModules, columnPixels - FRAME_PIXELS * 2)
  const span = spanModules * modulePixels

  // A layout effect rather than `useEffect`: it runs after the DOM is in place but
  // before the browser paints, so the measured pitch is the first one on screen.
  // With a plain effect the first painted frame would be the unmeasured one, and
  // on a phone that frame is the very downscale this is here to avoid.
  useLayoutEffect(() => {
    const column = columnRef.current
    if (column === null) return
    const measure = () => setColumnPixels(column.getBoundingClientRect().width)
    measure()
    // Rotating a phone changes the answer, and so does the payment panel above
    // this collapsing. Observed rather than read once so the symbol is never
    // stale at the moment somebody holds it up.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || span === 0) return
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
          (column + QR_QUIET_ZONE_MODULES) * modulePixels,
          (row + QR_QUIET_ZONE_MODULES) * modulePixels,
          modulePixels,
          modulePixels,
        )
      }
    }
  }, [matrix, modulePixels, span])

  return (
    // The thing that gets measured. A plain block element, so its width is the
    // column the receipt actually leaves for the symbol — including whatever the
    // printout's padding and sprocket strips have already taken.
    <div ref={columnRef}>
      {span > 0 && (
        <canvas
          ref={canvasRef}
          width={span}
          height={span}
          role="img"
          aria-label="Your pickup code as a QR code, for your bud to scan"
          className="mx-auto block border-2 border-rule"
          style={{
            // One CSS pixel per pixel of the backing store — `qrModulePixels` has
            // already made the symbol fit, so there is nothing for the browser to
            // resample. `maxWidth` stays as a structural backstop and is expected
            // to be inert; `e2e/qr-scale.spec.ts` asserts it never engages, because
            // when it does engage nothing reading the backing store can tell.
            width: `${span}px`,
            height: 'auto',
            maxWidth: '100%',
            // `border-box` (Tailwind's default) would take the 2px frame out of
            // the symbol instead of putting it around it, downscaling the canvas
            // by four pixels — small, fractional, and exactly the class of
            // invisible resample this file is now careful about.
            boxSizing: 'content-box',
          }}
        />
      )}
    </div>
  )
}

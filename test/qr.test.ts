import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import { pickupCodeFromScan, qrPayloadFor } from '../shared/handoff'
import { generatePickupCode, PICKUP_CODE_ALPHABET, PICKUP_CODE_LENGTH } from '../shared/pickup'
import {
  pickupQrMatrix,
  QR_ERROR_CORRECTION,
  QR_MODULE_PIXELS_MAX,
  QR_MODULE_PIXELS_MIN,
  QR_QUIET_ZONE_MODULES,
  QR_TYPE_AUTO,
  qrModulePixels,
  qrSpanModules,
} from '../shared/qr'

/** The origin a receipt prints against in these tests; the live one. */
const ORIGIN = 'https://nuggbudz.com'

/**
 * The longest origin this app is deployed under, and the one that sets the size.
 *
 * A `*.workers.dev` preview name is what a stage deploy prints against, and it
 * needs a denser symbol than production's own hostname does. Every width claim
 * below is measured against it rather than against `nuggbudz.com`, because the
 * narrowest phone on the longest origin is the case #127 was filed for.
 */
const PREVIEW_ORIGIN = 'https://nuggbudz-staging.2amlogic.workers.dev'

/**
 * The receipt column on the narrowest screen anybody browses on, in CSS pixels.
 *
 * 320 px viewport minus what `.printout` spends on padding and sprocket strips.
 * Measured — `e2e/qr-scale.spec.ts` is what asserts the real number against a
 * real browser; this is the floor the arithmetic here is allowed to assume.
 */
const NARROW_COLUMN_PIXELS = 236

/**
 * The encoder half of the scannable handoff.
 *
 * This file cannot prove the feature works — a decoder with a green unit test
 * and no wiring to `confirm_pickup` is the fifth defect of a shape this repo has
 * produced four times. `e2e/scan.spec.ts` is what proves the path, with a real
 * camera reading the orderer's real screen. What lives here is the part that is
 * genuinely a pure function: that the symbol a receipt prints carries a handoff
 * link for the pickup code, carries *only* that, and survives a round trip
 * through the same decoder the receiver's phone runs.
 *
 * What the link costs in modules is measured in `test/handoff.test.ts`.
 */

/**
 * Paint a matrix the way a camera would see it: dark modules on a pale field,
 * with the quiet zone, as RGBA.
 *
 * Deliberately generous — 8 device pixels per module — because the thing under
 * test here is the *encoding*, not how small a symbol a phone can resolve. The
 * hostile conditions (an angle, a glare band, a 640x480 sensor) are the browser
 * lane's business.
 */
function rasterize(matrix: boolean[][], scale = 8) {
  const span = qrSpanModules(matrix) * scale
  const rgba = new Uint8ClampedArray(span * span * 4).fill(255)
  for (const [row, cells] of matrix.entries()) {
    for (const [column, dark] of cells.entries()) {
      if (!dark) continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const y = (row + QR_QUIET_ZONE_MODULES) * scale + dy
          const x = (column + QR_QUIET_ZONE_MODULES) * scale + dx
          const at = (y * span + x) * 4
          rgba[at] = 0
          rgba[at + 1] = 0
          rgba[at + 2] = 0
        }
      }
    }
  }
  return { rgba, span }
}

function roundTrip(code: string) {
  const { rgba, span } = rasterize(pickupQrMatrix(code, ORIGIN))
  return jsQR(rgba, span, span)
}

/**
 * A deterministic sweep of the code alphabet rather than one hand-picked string.
 *
 * `PICKUP_CODE_ALPHABET` drops every character a stranger misreads off a
 * receipt, and a code is six of them. These walk the whole alphabet through every
 * position, so a character the encoder mishandles fails the build instead of
 * failing one buyer at a counter.
 */
const SWEEP = Array.from(PICKUP_CODE_ALPHABET, (_char, start) =>
  Array.from(
    { length: PICKUP_CODE_LENGTH },
    (_unused, place) =>
      PICKUP_CODE_ALPHABET[(start + place * 7) % PICKUP_CODE_ALPHABET.length] as string,
  ).join(''),
)

describe('the pickup code as a QR symbol', () => {
  it('encodes at the heaviest error correction, in the smallest version that fits', () => {
    // Level H is what survives a thumbprint, and it is kept even though the
    // payload grew. The version is derived rather than pinned: how long a
    // deployment's own hostname is decides it, and a pinned number would mean a
    // deploy whose receipt throws rather than one whose symbol is denser.
    expect(QR_ERROR_CORRECTION).toBe('H')
    expect(QR_TYPE_AUTO).toBe(0)
    // Four is the quiet zone the QR spec requires; less and decoders start
    // refusing a symbol that is otherwise perfect.
    expect(QR_QUIET_ZONE_MODULES).toBeGreaterThanOrEqual(4)
  })

  it('is a square matrix, with the margin reported separately', () => {
    const matrix = pickupQrMatrix('K7M2QX', ORIGIN)
    const side = matrix.length
    expect(side).toBeGreaterThan(0)
    for (const row of matrix) expect(row).toHaveLength(side)
    expect(qrSpanModules(matrix)).toBe(side + QR_QUIET_ZONE_MODULES * 2)
  })

  it('reads back as the handoff link for exactly that code', () => {
    for (const code of SWEEP) {
      const decoded = roundTrip(code)
      expect(decoded, `no symbol found for '${code}'`).not.toBeNull()
      expect(decoded?.data).toBe(qrPayloadFor(ORIGIN, code))
      // And the thing the receiver's scanner actually does with it.
      expect(pickupCodeFromScan(decoded?.data ?? '')).toBe(code)
    }
  })

  it('carries that link and nothing else', () => {
    // The constraint that matters for a symbol held up in a queue: one chunk,
    // whose text is the link and nothing beside it. A match id, a user id or a
    // session token would show up here as a second chunk or as a longer string.
    //
    // The link is not a secret and never was — see `shared/handoff.ts` — but a
    // *session token* alongside it would be, which is why this is asserted
    // exactly rather than loosely.
    const code = 'M4RK7Z'
    const decoded = roundTrip(code)
    expect(decoded?.chunks).toHaveLength(1)
    expect(decoded?.chunks[0]).toEqual({
      type: 'alphanumeric',
      text: qrPayloadFor(ORIGIN, code),
    })
    expect(decoded?.data).toHaveLength(ORIGIN.length + '/h/'.length + PICKUP_CODE_LENGTH)
  })

  it('round-trips codes the generator actually produces', () => {
    // The sweep above is synthetic. This runs the real generator, so a change to
    // the alphabet or the length has to pass through the encoder too.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generatePickupCode()
      expect(
        pickupCodeFromScan(roundTrip(code)?.data ?? ''),
        `generated code '${code}' did not round-trip`,
      ).toBe(code)
    }
  })

  it('is deterministic, so a receipt does not reprint a different symbol', () => {
    expect(pickupQrMatrix('QR7X4M', ORIGIN)).toEqual(pickupQrMatrix('QR7X4M', ORIGIN))
  })

  it('is decoded by one code path, on every phone', () => {
    // The mechanical half of a claim that cannot otherwise be tested here: this
    // suite runs Chromium, so no test in this repo exercises iOS Safari, where
    // `BarcodeDetector` does not exist. A `BarcodeDetector`-first design would
    // work on one demo phone and silently fall through on the other — and the
    // fallback would then be the untested path precisely when it is the one
    // running. So the guarantee is structural instead: there is no second decoder
    // to fall through *to*, and this is what keeps it that way.
    const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    // Named in a comment (`CodeScanner.tsx` explains why it is not used) but never
    // in code — so prose lines are skipped and everything else counts, including a
    // bare `'BarcodeDetector' in window` feature probe.
    const inCode = (text: string) =>
      text
        .split('\n')
        .some((line) => line.includes('BarcodeDetector') && !/^\s*(\*|\/\/)/.test(line))
    const offenders = Object.entries(sources)
      .filter(([, text]) => inCode(text))
      .map(([path]) => path)
    expect(
      offenders,
      'a second decode path means the pure-JS one becomes the untested path on ' +
        'exactly the phone that needs it',
    ).toEqual([])
  })

  it('refuses to encode anything that is not a pickup code', () => {
    // The payload rule enforced where it cannot be forgotten. Every one of these
    // is a thing somebody might reasonably reach for later.
    for (const value of [
      '',
      'K7M2Q',
      'K7M2QXY',
      'k7m2qx',
      'K7M2Q!',
      'K0M1QX', // 0 and 1 are off the alphabet on purpose: they read as O and I
      'https://nuggbudz.example/p/K7M2QX',
      'match:4f9c1a2b',
    ]) {
      expect(() => pickupQrMatrix(value, ORIGIN), `encoded '${value}'`).toThrow(/pickup code/)
    }
  })

  it('reports a span that includes the quiet zone, on both deployed origins', () => {
    // The number #127 was filed over. `matrix.length` is the data area; the span
    // is that plus four modules of margin on each side. Asserted for both origins
    // because the *longer* one is what decides how wide the symbol has to be, and
    // reading the shorter one is half of how the mistake was made.
    for (const origin of [ORIGIN, PREVIEW_ORIGIN]) {
      const matrix = pickupQrMatrix('K7M2QX', origin)
      expect(qrSpanModules(matrix)).toBe(matrix.length + 8)
      expect(qrSpanModules(matrix) - matrix.length).toBe(QR_QUIET_ZONE_MODULES * 2)
    }
    // And the longer origin genuinely costs modules, which is why a fixed pitch
    // cannot be sized against production's own hostname.
    expect(qrSpanModules(pickupQrMatrix('K7M2QX', PREVIEW_ORIGIN))).toBeGreaterThan(
      qrSpanModules(pickupQrMatrix('K7M2QX', ORIGIN)),
    )
  })

  it('refuses to encode against an origin that is not one', () => {
    // The other half of the payload rule now that there is a second argument: a
    // caller cannot reach the symbol's bytes through the origin either.
    for (const origin of ['', 'not a url', 'javascript:0', 'K7M2QX']) {
      expect(() => pickupQrMatrix('K7M2QX', origin), `encoded against '${origin}'`).toThrow(
        /handoff origin/,
      )
    }
  })
})

/**
 * How big the symbol is drawn, which until #127 was a constant nobody measured.
 *
 * This is arithmetic, so it belongs here; whether the *browser* then resamples
 * what was drawn is a question no unit test can answer, and `e2e/qr-scale.spec.ts`
 * is what answers it — by screenshotting the composited element at a 320px
 * viewport rather than reading the canvas's backing store.
 */
describe('the module pitch the symbol is drawn at', () => {
  it('fills the space when there is room for the full pitch', () => {
    for (const origin of [ORIGIN, PREVIEW_ORIGIN]) {
      const span = qrSpanModules(pickupQrMatrix('K7M2QX', origin))
      expect(qrModulePixels(span, span * QR_MODULE_PIXELS_MAX)).toBe(QR_MODULE_PIXELS_MAX)
      expect(qrModulePixels(span, 4096)).toBe(QR_MODULE_PIXELS_MAX)
    }
  })

  it('fits the narrowest phone on the longest origin, which the old constant did not', () => {
    const span = qrSpanModules(pickupQrMatrix('K7M2QX', PREVIEW_ORIGIN))
    // The regression itself: the pitch this repo used to hardcode does not fit.
    expect(span * QR_MODULE_PIXELS_MAX).toBeGreaterThan(NARROW_COLUMN_PIXELS)
    // And the derived one does, with whole pixels per module so the browser has
    // nothing to resample.
    const pitch = qrModulePixels(span, NARROW_COLUMN_PIXELS)
    expect(pitch).toBe(Math.floor(pitch))
    expect(span * pitch).toBeLessThanOrEqual(NARROW_COLUMN_PIXELS)
    expect(pitch).toBeGreaterThanOrEqual(QR_MODULE_PIXELS_MIN)
  })

  it('never returns a pitch whose symbol overflows the space it was given', () => {
    // Swept rather than spot-checked: every column width a phone or a desktop
    // could present, against both deployed origins.
    for (const origin of [ORIGIN, PREVIEW_ORIGIN]) {
      const span = qrSpanModules(pickupQrMatrix('K7M2QX', origin))
      for (let available = span * QR_MODULE_PIXELS_MIN; available <= 1200; available += 1) {
        const pitch = qrModulePixels(span, available)
        expect(span * pitch, `pitch ${pitch} overflows ${available}px`).toBeLessThanOrEqual(
          available,
        )
      }
    }
  })

  it('clamps rather than collapsing when the space is absurd or unmeasured', () => {
    const span = qrSpanModules(pickupQrMatrix('K7M2QX', PREVIEW_ORIGIN))
    // A container narrower than any real screen still gets a drawable symbol: a
    // pitch of zero would be a blank canvas, which is a worse failure than one
    // that overflows and is caught by the element's own `max-width`.
    expect(qrModulePixels(span, 0)).toBe(QR_MODULE_PIXELS_MIN)
    expect(qrModulePixels(span, -100)).toBe(QR_MODULE_PIXELS_MIN)
    // An unmeasured column — `getBoundingClientRect` on a detached node — must not
    // propagate `NaN` into the canvas's `width` attribute.
    expect(qrModulePixels(span, Number.NaN)).toBe(QR_MODULE_PIXELS_MAX)
    expect(qrModulePixels(0, 300)).toBe(QR_MODULE_PIXELS_MAX)
  })

  it('still decodes at the pitch the narrowest phone gets', () => {
    // The point of the minimum: a symbol drawn smaller on purpose is only a better
    // answer than a browser downscale if it still reads. Same decoder the
    // receiver's phone runs, on the longest origin, at the narrowest column.
    const matrix = pickupQrMatrix('K7M2QX', PREVIEW_ORIGIN)
    const pitch = qrModulePixels(qrSpanModules(matrix), NARROW_COLUMN_PIXELS)
    const { rgba, span } = rasterize(matrix, pitch)
    expect(jsQR(rgba, span, span)?.data).toBe(qrPayloadFor(PREVIEW_ORIGIN, 'K7M2QX'))
    // And at the floor, which is what a column narrower than any real phone gets.
    const floor = rasterize(matrix, QR_MODULE_PIXELS_MIN)
    expect(jsQR(floor.rgba, floor.span, floor.span)?.data).toBe(
      qrPayloadFor(PREVIEW_ORIGIN, 'K7M2QX'),
    )
  })
})

import qrcode from 'qrcode-generator'
import { describe, expect, it } from 'vitest'
import {
  HANDOFF_PATH_PREFIX,
  handoffUrl,
  isHandoffPath,
  pickupCodeFromPath,
  pickupCodeFromScan,
  qrPayloadFor,
} from '../shared/handoff'
import { generatePickupCode, PICKUP_CODE_ALPHABET, PICKUP_CODE_LENGTH } from '../shared/pickup'
import { pickupQrMatrix, QR_ERROR_CORRECTION } from '../shared/qr'

/**
 * The handoff link: what it accepts, what it refuses, and what it costs.
 *
 * The last of those is the point of the second half of this file. #101 traded a
 * 21-module symbol for one carrying a URL, and "the symbol got bigger" is not a
 * finding — *how much* bigger is, because at error-correction level H a denser
 * symbol is harder to read at arm's length across a table. So the module counts
 * are measured here rather than asserted from a comment, and the one that would
 * actually hurt a demo is pinned.
 */

/** The live origin. `README.md` calls it out; the deck prints it on a slide. */
const LIVE_ORIGIN = 'https://nuggbudz.com'
/** The `*.workers.dev` name the same Worker also answers on — the long one. */
const WORKERS_DEV_ORIGIN = 'https://nuggbudz.personal-account-251.workers.dev'

const CODE = 'K7M2QX'

describe('reading a code off a path', () => {
  it('takes the code out of a handoff path, in either case', () => {
    expect(pickupCodeFromPath(`/h/${CODE}`)).toBe(CODE)
    expect(pickupCodeFromPath(`/H/${CODE}`)).toBe(CODE)
    // The symbol is upper-cased whole, so `/H/` is the case a camera app
    // actually opens. Lower case is what a person types.
    expect(isHandoffPath(`/H/${CODE}`)).toBe(true)
  })

  it('tolerates the trailing slash a browser or a link-shortener may add', () => {
    expect(pickupCodeFromPath(`/h/${CODE}/`)).toBe(CODE)
  })

  it('is not somebody else’s URL', () => {
    for (const path of [
      '/',
      '/h',
      '/h/',
      `/h/${CODE}/extra`,
      `/hh/${CODE}`,
      `/health/${CODE}`,
      `/api/h/${CODE}`,
      '/h/K7M2Q', // five characters
      '/h/K7M2QXY', // seven
      '/h/K0M1QX', // 0 and 1 are off the alphabet: they read as O and I
      '/h/%2E%2E',
    ]) {
      expect(pickupCodeFromPath(path), `accepted '${path}'`).toBeNull()
    }
  })
})

describe('reading a code off a scan', () => {
  it('accepts the bare-code form a receipt from before #101 prints', () => {
    expect(pickupCodeFromScan(CODE)).toBe(CODE)
    // Spaces and dashes are what a person adds reading six characters aloud.
    expect(pickupCodeFromScan(' k7m-2qx ')).toBe(CODE)
  })

  it('accepts the link form, whatever origin it points at', () => {
    for (const raw of [
      `https://nuggbudz.com/h/${CODE}`,
      `HTTPS://NUGGBUDZ.COM/H/${CODE}`,
      `http://localhost:5199/h/${CODE}`,
      `https://nuggbudz.personal-account-251.workers.dev/h/${CODE}`,
      // Another deployment's link is still a pickup code. The server is the one
      // that decides whether it is *this* match's, and it always was.
      `https://someone-elses-preview.example/h/${CODE}`,
    ]) {
      expect(pickupCodeFromScan(raw), `refused '${raw}'`).toBe(CODE)
    }
  })

  it('refuses everything else a camera might catch in frame', () => {
    for (const raw of [
      '',
      'WIFI:S:CafeGuest;T:WPA;P:nuggets;;',
      'https://nuggbudz.com/',
      `https://nuggbudz.com/?code=${CODE}`,
      `https://nuggbudz.com/h/${CODE}?confirm=1`,
      `https://nuggbudz.com/h/${CODE}#settle`,
      `javascript:alert('${CODE}')`,
      `mailto:nugg@example.com?subject=${CODE}`,
      'match:4f9c1a2b-0000-4000-8000-000000000000',
      'K7M2Q',
      'K7M2QXY',
    ]) {
      expect(pickupCodeFromScan(raw), `accepted '${raw}'`).toBeNull()
    }
  })

  it('round-trips every code the generator produces, through the link form', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = generatePickupCode()
      expect(pickupCodeFromScan(qrPayloadFor(LIVE_ORIGIN, code))).toBe(code)
      expect(pickupCodeFromScan(handoffUrl(LIVE_ORIGIN, code))).toBe(code)
    }
  })

  it('walks the whole alphabet through every position', () => {
    // A character the path parser or the upper-casing mishandles fails the build
    // instead of failing one buyer at a counter.
    for (const [start] of Array.from(PICKUP_CODE_ALPHABET).entries()) {
      const code = Array.from(
        { length: PICKUP_CODE_LENGTH },
        (_unused, place) =>
          PICKUP_CODE_ALPHABET[(start + place * 7) % PICKUP_CODE_ALPHABET.length] as string,
      ).join('')
      expect(pickupCodeFromScan(qrPayloadFor(LIVE_ORIGIN, code)), code).toBe(code)
    }
  })
})

describe('building a handoff link', () => {
  it('points at the origin it was given, on the one-character path', () => {
    expect(handoffUrl(LIVE_ORIGIN, CODE)).toBe(`https://nuggbudz.com${HANDOFF_PATH_PREFIX}${CODE}`)
    expect(handoffUrl('http://localhost:5199', CODE)).toBe(`http://localhost:5199/h/${CODE}`)
    // Only the origin of whatever it is handed: a path, a query or a fragment on
    // the way in is not a place a pickup code belongs.
    expect(handoffUrl('https://nuggbudz.com/deals?x=1#y', CODE)).toBe(
      `https://nuggbudz.com/h/${CODE}`,
    )
  })

  it('refuses to build a link for anything that is not a pickup code', () => {
    for (const value of ['', 'K7M2Q', 'K7M2QXY', 'k7m2qx', 'K7M2Q!', 'K0M1QX']) {
      expect(() => handoffUrl(LIVE_ORIGIN, value), `built one for '${value}'`).toThrow(
        /not a pickup code/,
      )
    }
  })

  it('refuses an origin that is not an http(s) one', () => {
    for (const origin of ['', 'nuggbudz.com', 'javascript:0', 'file:///tmp', 'ws://nuggbudz.com']) {
      expect(() => handoffUrl(origin, CODE), `accepted '${origin}'`).toThrow(/handoff origin/)
    }
  })
})

/**
 * What the symbol costs, measured.
 *
 * `modulesFor` builds the symbol the same way `shared/qr.ts` does — same
 * auto-version, same level H — so these are the numbers a receipt actually
 * prints, not a model of them.
 */
function modulesFor(payload: string, mode: 'Alphanumeric' | 'Byte'): number {
  const symbol = qrcode(0, QR_ERROR_CORRECTION)
  symbol.addData(payload, mode)
  symbol.make()
  return symbol.getModuleCount()
}

const modulesOf = (code: string, origin: string) => pickupQrMatrix(code, origin).length

describe('what carrying a URL costs the symbol', () => {
  it('was 21 modules for the bare code', () => {
    // The #92 baseline, still measurable: a six-character code in alphanumeric
    // mode fits version 1 even at level H.
    expect(modulesFor(CODE, 'Alphanumeric')).toBe(21)
  })

  it('is 29 modules for the live origin, and 37 for the long workers.dev one', () => {
    // The number that matters on stage, pinned. A payload that grew past
    // version 3's 32-character alphanumeric budget would push this to 33 and
    // shrink every module by a quarter at a fixed on-screen size, which is
    // exactly the kind of regression that is invisible until somebody is
    // holding a phone across a table.
    expect(modulesOf(CODE, LIVE_ORIGIN)).toBe(29)
    expect(modulesOf(CODE, WORKERS_DEV_ORIGIN)).toBe(37)
  })

  it('does not depend on which code it is carrying', () => {
    // Every pickup code is the same six characters' worth of payload, so the
    // symbol is the same size for all of them — the cost is the origin's.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(modulesOf(generatePickupCode(), LIVE_ORIGIN)).toBe(29)
    }
  })

  it('is smaller upper-cased than it would be in byte mode', () => {
    // The whole reason `qrPayloadFor` upper-cases. Alphanumeric mode spends 11
    // bits per two characters where byte mode spends 8 per one, and a URL's
    // scheme and host are case-insensitive, so this is free.
    const upper = qrPayloadFor(LIVE_ORIGIN, CODE)
    const asIs = handoffUrl(LIVE_ORIGIN, CODE)
    expect(upper).toBe(asIs.toUpperCase())
    expect(modulesFor(upper, 'Alphanumeric')).toBeLessThan(modulesFor(asIs, 'Byte'))
    expect(modulesFor(qrPayloadFor(WORKERS_DEV_ORIGIN, CODE), 'Alphanumeric')).toBeLessThan(
      modulesFor(handoffUrl(WORKERS_DEV_ORIGIN, CODE), 'Byte'),
    )
  })

  it('would save nothing by dropping the scheme', () => {
    // Worth measuring once rather than assuming, because eight characters looks
    // like it should buy something. It does not: 21 characters and 29 both land
    // in the same version-3 symbol, and a bare host is a guess about whether a
    // camera app linkifies it.
    const schemeless = `NUGGBUDZ.COM${HANDOFF_PATH_PREFIX.toUpperCase()}${CODE}`
    expect(modulesFor(schemeless, 'Alphanumeric')).toBe(modulesOf(CODE, LIVE_ORIGIN))
  })
})

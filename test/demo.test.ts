import { describe, expect, it } from 'vitest'
import { demoPairingEnabled, demoUserId, isDemoUserId, sanitizeDemoName } from '../shared/demo'

/** Spell hostile code points by number — invisible literals are unreviewable. */
const cp = (code: number) => String.fromCodePoint(code)
/** U+FFFD, what a half-sliced surrogate pair decodes to. */
const REPLACEMENT = cp(0xfffd)

describe('demoPairingEnabled', () => {
  it('is off when the var is absent — the production default', () => {
    expect(demoPairingEnabled(undefined)).toBe(false)
  })

  it('accepts the spellings an operator would plausibly pass', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      expect(demoPairingEnabled(raw)).toBe(true)
    }
  })

  it('treats anything else as off rather than guessing', () => {
    for (const raw of ['', '0', 'false', 'no', 'off', 'maybe', 'True!']) {
      expect(demoPairingEnabled(raw)).toBe(false)
    }
  })
})

describe('sanitizeDemoName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeDemoName('Robb')).toBe('Robb')
  })

  it('trims and collapses whitespace', () => {
    expect(sanitizeDemoName('  Robb   W  ')).toBe('Robb W')
  })

  it('falls back to Guest rather than showing an empty buddy card', () => {
    expect(sanitizeDemoName('')).toBe('Guest')
    expect(sanitizeDemoName('   ')).toBe('Guest')
    expect(sanitizeDemoName(null)).toBe('Guest')
    expect(sanitizeDemoName(undefined)).toBe('Guest')
    // A non-string arrives whenever a caller hand-writes the query string.
    expect(sanitizeDemoName(42 as unknown as string)).toBe('Guest')
  })

  it('strips control characters, which an unauthenticated caller can send', () => {
    const withControls = `Ro${String.fromCharCode(0)}bb${String.fromCharCode(27)}`
    expect(sanitizeDemoName(withControls)).toBe('Robb')
    expect(sanitizeDemoName(String.fromCharCode(127))).toBe('Guest')
    // A newline is whitespace, so it collapses rather than splitting the name.
    expect(sanitizeDemoName('Robb\nWalters')).toBe('Robb Walters')
  })

  it('caps length so one caller cannot blow out every buddy card', () => {
    expect(sanitizeDemoName('x'.repeat(200))).toHaveLength(40)
  })

  it('leaves emoji and non-Latin names intact', () => {
    expect(sanitizeDemoName('Даша')).toBe('Даша')
    expect(sanitizeDemoName('Robb 🍗')).toBe('Robb 🍗')
  })

  it('strips C1 controls, which both JS \\s and a >= 0x20 check miss', () => {
    // U+0085 NEL and U+009F APC are invisible and sit *above* the printable
    // boundary a hand-rolled control-character check draws at U+0020, so they
    // used to reach a buddy card intact.
    expect(sanitizeDemoName(`Robb${cp(0x85)}W`)).toBe('RobbW')
    expect(sanitizeDemoName(`Robb${cp(0x9f)}`)).toBe('Robb')
    expect(sanitizeDemoName(`${cp(0x80)}${cp(0x9f)}`)).toBe('Guest')
  })

  it('strips zero-width characters, so a name cannot smuggle bytes', () => {
    expect(sanitizeDemoName(`Ro${cp(0x200b)}bb`)).toBe('Robb')
    // ZWJ and the word joiner go the same way. A ZWJ emoji sequence therefore
    // renders as its components — an accepted cost of allowing no invisibles.
    expect(sanitizeDemoName(`Robb${cp(0x200d)}${cp(0x2060)}`)).toBe('Robb')
    expect(sanitizeDemoName(cp(0x200b))).toBe('Guest')
  })

  it('strips bidi overrides, the one real display-spoofing primitive here', () => {
    // U+202E reverses the rendering of everything after it, so stored bytes and
    // the glyphs a stranger reads off the card stop agreeing.
    const spoofed = sanitizeDemoName(`Robb${cp(0x202e)}sretlaW`)
    expect(spoofed).toBe('RobbsretlaW')
    expect(spoofed).not.toContain(cp(0x202e))
    for (const bidi of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2069]) {
      expect(sanitizeDemoName(`Robb${cp(bidi)}`)).toBe('Robb')
    }
  })

  it('drops a lone surrogate rather than passing U+FFFD to the card', () => {
    expect(sanitizeDemoName(`Robb${String.fromCharCode(0xd83c)}`)).toBe('Robb')
    expect(sanitizeDemoName(String.fromCharCode(0xdfd7))).toBe('Guest')
  })

  it('caps by grapheme, so the cap never slices a surrogate pair', () => {
    // 39 plain characters put the emoji's leading surrogate exactly on the
    // 40th UTF-16 code unit — the boundary a `slice(0, 40)` cuts through.
    const capped = sanitizeDemoName(`${'x'.repeat(39)}🍗Walters`)
    expect(capped).toBe(`${'x'.repeat(39)}🍗`)
    expect(capped).not.toContain(REPLACEMENT)
    const allEmoji = sanitizeDemoName('🍗'.repeat(60))
    expect(Array.from(allEmoji)).toHaveLength(40)
    expect(allEmoji).not.toContain(REPLACEMENT)
  })

  it('keeps a combining mark attached to its base letter when capping', () => {
    const accented = `e${cp(0x301)}`
    expect(sanitizeDemoName(accented.repeat(45))).toBe(accented.repeat(40))
  })

  it('trims after capping, so the cap cannot leave a trailing space', () => {
    expect(sanitizeDemoName(`${'x'.repeat(39)} Walters`)).toBe('x'.repeat(39))
  })

  it('still caps by code point where Intl.Segmenter is unavailable', () => {
    // Coarser than graphemes, but the point of the fallback is that it is also
    // never mid-pair. Workers ships full ICU; a stripped-ICU host would not.
    const intl = Intl as { Segmenter?: typeof Intl.Segmenter }
    const original = intl.Segmenter
    delete intl.Segmenter
    try {
      const capped = sanitizeDemoName(`${'x'.repeat(39)}🍗Walters`)
      expect(capped).toBe(`${'x'.repeat(39)}🍗`)
      expect(capped).not.toContain(REPLACEMENT)
    } finally {
      intl.Segmenter = original
    }
  })

  // Kept from the concurrent attempt on this branch (7da2bff): a mixed
  // all-invisible input, spanning ZWSP / ZWNJ / ZWJ / BOM / RLO at once.
  it('collapses an all-invisible-character input to Guest', () => {
    const invisible = [0x200b, 0x200c, 0x200d, 0xfeff, 0x202e].map((code) => cp(code))
    expect(sanitizeDemoName(invisible.join(''))).toBe('Guest')
  })
})

describe('demoUserId', () => {
  it('prefixes so a throwaway is never mistaken for a real account', () => {
    expect(demoUserId('abc')).toBe('demo:abc')
    expect(isDemoUserId(demoUserId('abc'))).toBe(true)
  })

  it('does not classify a real account id as a demo one', () => {
    expect(isDemoUserId('108124099234')).toBe(false)
    expect(isDemoUserId('google:demo')).toBe(false)
  })

  it('is distinct per call site input, so two tabs cannot collide', () => {
    expect(demoUserId('one')).not.toBe(demoUserId('two'))
  })
})

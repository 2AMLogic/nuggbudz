import { describe, expect, it } from 'vitest'
import { demoPairingEnabled, demoUserId, isDemoUserId, sanitizeDemoName } from '../shared/demo'

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

  it('strips C1 control characters (U+0080-U+009F), which \\s does not match', () => {
    // U+0085 (NEL) sits in the C1 block and is neither \s nor C0/DEL.
    expect(sanitizeDemoName(`Robb${String.fromCharCode(0x85)}W`)).toBe('RobbW')
    expect(sanitizeDemoName(String.fromCharCode(0x9f))).toBe('Guest')
  })

  it('strips zero-width and bidi-override format characters (Unicode Cf)', () => {
    // Zero-width space (U+200B) between two words.
    expect(sanitizeDemoName(`Robb${String.fromCharCode(0x200b)}Walters`)).toBe('RobbWalters')
    // RTL override (U+202E) is the display-spoofing primitive this guards against.
    expect(sanitizeDemoName(`Robb${String.fromCharCode(0x202e)}Walters`)).toBe('RobbWalters')
  })

  it('collapses an all-invisible-character input to Guest', () => {
    const invisible = [0x200b, 0x200c, 0x200d, 0xfeff, 0x202e].map((code) =>
      String.fromCharCode(code),
    )
    expect(sanitizeDemoName(invisible.join(''))).toBe('Guest')
  })

  it('caps by code point, never splitting a surrogate pair', () => {
    // 39 plain characters plus a trailing emoji (a surrogate pair) lands the
    // emoji exactly on the 40-code-point boundary — it must survive whole,
    // never decode to a lone surrogate / U+FFFD.
    const name = `${'x'.repeat(39)}🍗`
    const result = sanitizeDemoName(name)
    expect(result).toBe(name)
    expect(result).not.toContain('�')
    expect(Array.from(result)).toHaveLength(40)
  })

  it('preserves whitespace-before-control ordering (regression guard)', () => {
    // A newline must separate words, never glue them — this ordering was
    // explicitly verified in #24 and must not regress while adding the new
    // C1/Cf filtering above it.
    expect(sanitizeDemoName('Robb\nWalters')).toBe('Robb Walters')
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

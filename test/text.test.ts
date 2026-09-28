import { describe, expect, it } from 'vitest'
import { countCodePoints, sanitizeDisplayText } from '../shared/text'

/**
 * `sanitizeDisplayText` now has three independent callers (`shared/demo.ts`,
 * `shared/chat.ts`, `shared/disputes.ts`) that each pin their own policy cap
 * and fallback — see `test/demo.test.ts` and `test/chat.test.ts`. This file
 * covers the sanitizer itself, directly, so a case does not have to be routed
 * through one caller's cap or fallback to be exercised.
 */
describe('sanitizeDisplayText', () => {
  it('caps on grapheme boundaries, keeping a combining mark attached', () => {
    // 'e' + combining acute accent (U+0301) is two code points but one
    // grapheme cluster. Capping by code point would split them, stranding a
    // bare accent at the boundary; capping by grapheme keeps the pair whole.
    const base = 'x'.repeat(39)
    const combining = `e${String.fromCharCode(0x0301)}`
    const text = sanitizeDisplayText(`${base}${combining}Extra`, 40)
    expect(text).toBe(`${base}${combining}`)
    expect(countCodePoints(text)).toBe(41)
  })

  it('trims after capping rather than leaving a trailing space', () => {
    // The 40th grapheme is the space in ' Walters' — trimming after the cap,
    // not before, is what keeps this from ending on a space.
    const text = sanitizeDisplayText(`${'x'.repeat(39)} Walters`, 40)
    expect(text).toBe('x'.repeat(39))
    expect(text.endsWith(' ')).toBe(false)
  })

  it('caps an all-emoji string to the requested grapheme count', () => {
    const text = sanitizeDisplayText('🍗'.repeat(50), 40)
    expect(countCodePoints(text)).toBe(40)
  })

  it('strips a lone surrogate passed directly, not only via a URL', () => {
    // WHATWG URL parsing already replaces a lone surrogate with U+FFFD before a
    // Worker ever reads one off a query string, so that path can't exercise
    // this. A JSON body or header can hand one straight through, though.
    const loneHighSurrogate = String.fromCharCode(0xd800)
    const text = sanitizeDisplayText(`Robb${loneHighSurrogate}Walters`, 40)
    expect(text).toBe('RobbWalters')
    expect(text).not.toContain(loneHighSurrogate)
  })

  it('falls back to code-point capping when Intl.Segmenter is unavailable', () => {
    const intl = Intl as unknown as { Segmenter?: typeof Intl.Segmenter }
    const original = intl.Segmenter
    // Deliberately removing a global to exercise the fallback path. `Segmenter`
    // is typed readonly, so the cast above is what makes this assignable — it
    // is still an ordinary mutable property at runtime.
    intl.Segmenter = undefined
    try {
      // Code-point capping still can't split a surrogate pair (the fallback
      // that fixed #41), so the emoji at the boundary survives whole even
      // without Intl.Segmenter.
      const name = `${'x'.repeat(39)}🍗`
      const result = sanitizeDisplayText(name, 40)
      expect(result).toBe(name)
      expect(result).not.toContain('�')
    } finally {
      intl.Segmenter = original
    }
  })

  it('does not strip U+FFFD itself — mojibake, not a spoofing character', () => {
    expect(sanitizeDisplayText('Robb�Walters', 40)).toBe('Robb�Walters')
  })

  it('preserves whitespace-before-control-strip ordering (regression guard, #24)', () => {
    expect(sanitizeDisplayText('Robb\nWalters', 40)).toBe('Robb Walters')
  })

  it('reports "nothing survived" rather than guessing', () => {
    expect(sanitizeDisplayText('', 40)).toBe('')
    expect(sanitizeDisplayText(undefined, 40)).toBe('')
    expect(sanitizeDisplayText(null, 40)).toBe('')
  })
})

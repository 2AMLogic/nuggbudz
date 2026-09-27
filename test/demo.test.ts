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

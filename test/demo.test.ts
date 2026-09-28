import { describe, expect, it } from 'vitest'
import {
  DEMO_COOKIE,
  DEMO_TOKEN_LENGTH,
  DEMO_TTL_SECONDS,
  demoCookie,
  demoPairingEnabled,
  demoTokenFromCookieHeader,
  demoUserId,
  isDemoTokenShaped,
  isDemoUserId,
  sanitizeDemoName,
} from '../shared/demo'
import { classifyUserId } from '../shared/identity'

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

  it('caps on grapheme boundaries, keeping a combining mark attached', () => {
    // 'e' + combining acute accent (U+0301) is two code points but one
    // grapheme cluster — capping by code point would strand a bare accent at
    // the 40-character boundary; capping by grapheme keeps the pair whole.
    const base = 'x'.repeat(39)
    const combining = `e${String.fromCharCode(0x0301)}`
    expect(sanitizeDemoName(`${base}${combining}Extra`)).toBe(`${base}${combining}`)
  })

  it('trims after capping rather than leaving a trailing space', () => {
    // The 40th grapheme is the space in ' Walters'; trimming after the cap is
    // what keeps this from ending on one.
    expect(sanitizeDemoName(`${'x'.repeat(39)} Walters`)).toBe('x'.repeat(39))
  })

  it('strips a lone surrogate, not just a full surrogate pair', () => {
    const loneHighSurrogate = String.fromCharCode(0xd800)
    expect(sanitizeDemoName(`Robb${loneHighSurrogate}Walters`)).toBe('RobbWalters')
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

  it('is distinct per call site input, so two buyers cannot collide', () => {
    expect(demoUserId('one')).not.toBe(demoUserId('two'))
  })

  it('is the *same* for two sockets of one browser, which is the #101 trade', () => {
    // Stated as a test rather than only as prose, because it is the behaviour
    // change: the same demo cookie yields the same identity, which is what lets
    // a new tab opened by a phone's camera app be recognised as the receiver of
    // a live match — and what makes two tabs on one laptop one buyer.
    const token = 'a'.repeat(DEMO_TOKEN_LENGTH)
    expect(demoUserId(token)).toBe(demoUserId(token))
  })
})

describe('the demo identity cookie', () => {
  const token = 'Yk7v-Zq_3'.padEnd(DEMO_TOKEN_LENGTH, 'x').slice(0, DEMO_TOKEN_LENGTH)

  it('accepts only a token this server could have minted', () => {
    expect(isDemoTokenShaped(token)).toBe(true)
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'short',
      'x'.repeat(DEMO_TOKEN_LENGTH - 1),
      'x'.repeat(DEMO_TOKEN_LENGTH + 1),
      // Not base64url. A cookie is attacker-controlled and its value is spliced
      // into a user id, so the charset is the boundary that keeps `demo:` ids
      // from carrying anything a log or a ledger gate would have to cope with.
      `${'x'.repeat(DEMO_TOKEN_LENGTH - 1)}+`,
      `${'x'.repeat(DEMO_TOKEN_LENGTH - 1)}/`,
      `${'x'.repeat(DEMO_TOKEN_LENGTH - 1)};`,
    ]) {
      expect(isDemoTokenShaped(bad), `accepted ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('reads its own cookie back, and ignores a malformed one', () => {
    const header = demoCookie(token, { secure: true }).split(';')[0]
    expect(demoTokenFromCookieHeader(header)).toBe(token)
    expect(demoTokenFromCookieHeader(`nb_session=abc; ${header}`)).toBe(token)
    expect(demoTokenFromCookieHeader(null)).toBeNull()
    expect(demoTokenFromCookieHeader('')).toBeNull()
    expect(demoTokenFromCookieHeader(`${DEMO_COOKIE}=nope`)).toBeNull()
    expect(demoTokenFromCookieHeader('nb_session=abc')).toBeNull()
  })

  it('is HttpOnly and SameSite=Lax, because the link is a top-level navigation', () => {
    const cookie = demoCookie(token, { secure: true })
    expect(cookie).toContain('HttpOnly')
    // Load-bearing rather than conventional: a phone's camera app opening
    // `/h/<code>` is a top-level navigation, which `Lax` sends the cookie on and
    // `Strict` would not — and dropping it there is exactly the failure this
    // cookie exists to prevent.
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain(`Max-Age=${DEMO_TTL_SECONDS}`)
    expect(cookie).toContain('Path=/')
  })

  it('is Secure only over TLS, so a stage laptop on http keeps its identity', () => {
    expect(demoCookie(token, { secure: true })).toContain('Secure')
    expect(demoCookie(token, { secure: false })).not.toContain('Secure')
  })

  it('yields a user id the ledger gate still reads as a demo one', () => {
    // The whole point of the prefix: a cookie-backed demo identity must book no
    // money, exactly as a per-socket one did.
    expect(classifyUserId(demoUserId(token))).toBe('demo')
    expect(isDemoUserId(demoUserId(token))).toBe(true)
  })
})

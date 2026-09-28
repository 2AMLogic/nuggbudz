import { describe, expect, it } from 'vitest'
import {
  buildGoogleAuthorizeUrl,
  checkAuthState,
  checkGoogleIdTokenClaims,
  clampDisplayName,
  clearedSessionCookie,
  displayNameFromClaims,
  type GoogleIdTokenClaims,
  isSessionIdShaped,
  parseCookies,
  parsePendingAuthRecord,
  parseSessionRecord,
  publicUser,
  SESSION_COOKIE,
  sessionCookie,
  sessionIdFromCookieHeader,
  timingSafeEqual,
} from '../shared/auth'

const NOW = 1_800_000_000
const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com'

const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '108423991242',
  exp: NOW + 3600,
  iat: NOW - 5,
  email: 'robb@example.com',
  email_verified: true,
  name: 'Robb Walters',
  picture: 'https://lh3.googleusercontent.com/a/robb',
  ...over,
})

describe('checkGoogleIdTokenClaims', () => {
  it('accepts a live token minted for us', () => {
    const result = checkGoogleIdTokenClaims(claims(), { clientId: CLIENT_ID, now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims.sub).toBe('108423991242')
    expect(result.claims.email).toBe('robb@example.com')
    expect(result.claims.emailVerified).toBe(true)
    expect(result.claims.picture).toBe('https://lh3.googleusercontent.com/a/robb')
  })

  it('accepts both spellings of the Google issuer', () => {
    for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
      expect(checkGoogleIdTokenClaims(claims({ iss }), { clientId: CLIENT_ID, now: NOW }).ok).toBe(
        true,
      )
    }
  })

  it('rejects a token issued by anyone else', () => {
    for (const iss of [
      'https://accounts.google.com.evil.example',
      'https://evil.example',
      'accounts.google.com ',
      '',
    ]) {
      expect(checkGoogleIdTokenClaims(claims({ iss }), { clientId: CLIENT_ID, now: NOW })).toEqual({
        ok: false,
        reason: 'bad_issuer',
      })
    }
  })

  it('rejects a token minted for a different client — the bypass aud exists to stop', () => {
    expect(
      checkGoogleIdTokenClaims(claims({ aud: 'someone-else.apps.googleusercontent.com' }), {
        clientId: CLIENT_ID,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad_audience' })
  })

  it('accepts a multi-audience token only when ours is among them', () => {
    expect(
      checkGoogleIdTokenClaims(claims({ aud: ['other', CLIENT_ID] }), {
        clientId: CLIENT_ID,
        now: NOW,
      }).ok,
    ).toBe(true)
    expect(
      checkGoogleIdTokenClaims(claims({ aud: ['other', 'another'] }), {
        clientId: CLIENT_ID,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad_audience' })
  })

  it('never matches an unconfigured client id', () => {
    expect(checkGoogleIdTokenClaims(claims({ aud: '' }), { clientId: '', now: NOW })).toEqual({
      ok: false,
      reason: 'malformed_claims',
    })
    expect(checkGoogleIdTokenClaims(claims(), { clientId: '', now: NOW })).toEqual({
      ok: false,
      reason: 'bad_audience',
    })
  })

  it('rejects an expired token, allowing only a minute of skew', () => {
    expect(
      checkGoogleIdTokenClaims(claims({ exp: NOW - 120 }), { clientId: CLIENT_ID, now: NOW }),
    ).toEqual({ ok: false, reason: 'expired' })
    // Inside the leeway window a just-expired token is still accepted.
    expect(
      checkGoogleIdTokenClaims(claims({ exp: NOW - 30 }), { clientId: CLIENT_ID, now: NOW }).ok,
    ).toBe(true)
    expect(
      checkGoogleIdTokenClaims(claims({ exp: NOW - 30 }), {
        clientId: CLIENT_ID,
        now: NOW,
        leewaySeconds: 0,
      }),
    ).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token issued in the future', () => {
    expect(
      checkGoogleIdTokenClaims(claims({ iat: NOW + 600 }), { clientId: CLIENT_ID, now: NOW }),
    ).toEqual({ ok: false, reason: 'issued_in_future' })
  })

  it('rejects malformed claim sets', () => {
    expect(checkGoogleIdTokenClaims(null, { clientId: CLIENT_ID, now: NOW }).ok).toBe(false)
    expect(checkGoogleIdTokenClaims('nope', { clientId: CLIENT_ID, now: NOW }).ok).toBe(false)
    for (const over of [
      { sub: '' },
      { sub: 42 },
      { iss: 7 },
      { exp: 'soon' },
      { iat: Number.NaN },
      { aud: [] },
      { aud: [CLIENT_ID, 3] },
    ]) {
      expect(checkGoogleIdTokenClaims(claims(over), { clientId: CLIENT_ID, now: NOW })).toEqual({
        ok: false,
        reason: 'malformed_claims',
      })
    }
  })

  it('checks the nonce when one was requested', () => {
    expect(
      checkGoogleIdTokenClaims(claims({ nonce: 'abc' }), {
        clientId: CLIENT_ID,
        now: NOW,
        nonce: 'abc',
      }).ok,
    ).toBe(true)
    expect(
      checkGoogleIdTokenClaims(claims({ nonce: 'abc' }), {
        clientId: CLIENT_ID,
        now: NOW,
        nonce: 'xyz',
      }),
    ).toEqual({ ok: false, reason: 'nonce_mismatch' })
  })

  it('tolerates a missing profile without failing the sign-in', () => {
    const result = checkGoogleIdTokenClaims(
      { iss: 'accounts.google.com', aud: CLIENT_ID, sub: '9', exp: NOW + 60, iat: NOW },
      { clientId: CLIENT_ID, now: NOW },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims).toMatchObject({ email: null, emailVerified: false, name: null })
  })
})

describe('checkAuthState', () => {
  const pending = {
    state: 'y'.repeat(43),
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(22),
    redirectUri: 'https://nuggbudz.example/api/auth/google/callback',
    createdAt: 1,
  }

  it('accepts the state it stashed', () => {
    expect(checkAuthState(pending.state, pending)).toEqual({ ok: true, pending })
  })

  it('rejects a callback with no usable state', () => {
    for (const received of [undefined, null, '', 'short', 42, {}]) {
      expect(checkAuthState(received, pending)).toEqual({ ok: false, reason: 'missing_state' })
    }
  })

  it('rejects a state that is not on record — an expired or forged attempt', () => {
    expect(checkAuthState(pending.state, null)).toEqual({ ok: false, reason: 'unknown_state' })
  })

  it('rejects a state that does not match the stashed one', () => {
    expect(checkAuthState('z'.repeat(43), pending)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    })
    expect(checkAuthState(`${pending.state}extra`, pending)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    })
  })
})

describe('timingSafeEqual', () => {
  it('compares content, not identity', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'ab')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('a', '')).toBe(false)
  })
})

describe('parsePendingAuthRecord', () => {
  const record = {
    state: 's'.repeat(43),
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(22),
    redirectUri: 'https://nuggbudz.example/api/auth/google/callback',
    createdAt: 5,
  }

  it('accepts a well-formed record', () => {
    expect(parsePendingAuthRecord(record)).toEqual(record)
  })

  it('carries the stashed nonce back out for the callback to check', () => {
    expect(parsePendingAuthRecord(record)?.nonce).toBe('n'.repeat(22))
  })

  it('rejects records that could weaken PKCE or the redirect', () => {
    expect(parsePendingAuthRecord(null)).toBeNull()
    expect(parsePendingAuthRecord({ ...record, state: '' })).toBeNull()
    // RFC 7636 floors a verifier at 43 characters.
    expect(parsePendingAuthRecord({ ...record, codeVerifier: 'short' })).toBeNull()
    expect(parsePendingAuthRecord({ ...record, redirectUri: '' })).toBeNull()
    expect(parsePendingAuthRecord({ ...record, createdAt: 'now' })).toBeNull()
  })

  it('rejects a record with no usable nonce rather than skipping the check', () => {
    const { state, codeVerifier, redirectUri, createdAt } = record
    expect(parsePendingAuthRecord({ state, codeVerifier, redirectUri, createdAt })).toBeNull()
    expect(parsePendingAuthRecord({ ...record, nonce: '' })).toBeNull()
    expect(parsePendingAuthRecord({ ...record, nonce: 42 })).toBeNull()
  })
})

describe('sessions', () => {
  const record = {
    userId: 'a0d3',
    googleSub: '108423991242',
    displayName: 'Robb',
    email: 'robb@example.com',
    avatarUrl: null,
    createdAt: 1,
  }

  it('round-trips a stored session', () => {
    expect(parseSessionRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('rejects a session missing an identity', () => {
    expect(parseSessionRecord(null)).toBeNull()
    expect(parseSessionRecord({ ...record, userId: '' })).toBeNull()
    expect(parseSessionRecord({ ...record, googleSub: 42 })).toBeNull()
    expect(parseSessionRecord({ ...record, displayName: '   ' })).toBeNull()
    expect(parseSessionRecord({ ...record, createdAt: null })).toBeNull()
  })

  it('normalises a stored display name to what the protocol allows', () => {
    const long = parseSessionRecord({ ...record, displayName: `  ${'n'.repeat(60)}  ` })
    expect(long?.displayName).toHaveLength(40)
  })

  it('drops non-string email and avatar rather than trusting them', () => {
    expect(parseSessionRecord({ ...record, email: 12, avatarUrl: {} })).toMatchObject({
      email: null,
      avatarUrl: null,
    })
  })

  it('hands the client only its own public fields', () => {
    expect(publicUser(record)).toEqual({
      id: 'a0d3',
      displayName: 'Robb',
      email: 'robb@example.com',
      avatarUrl: null,
    })
  })
})

describe('session cookie', () => {
  // 32 random bytes as base64url: exactly 43 characters, the shape the Worker mints.
  const id = 'Zm9vYmFyYmF6cXV1eGZvb2JhcmJhemZvb2JhcmJhegA'

  it('is HttpOnly, Secure and SameSite=Lax', () => {
    const cookie = sessionCookie(id)
    expect(cookie.startsWith(`${SESSION_COOKIE}=${id}`)).toBe(true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=2592000')
  })

  it('clears with the same attributes so the browser replaces it', () => {
    const cleared = clearedSessionCookie()
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('HttpOnly')
    expect(cleared).toContain('Secure')
    expect(cleared).toContain('SameSite=Lax')
  })

  it('only accepts an opaque, full-length session id', () => {
    expect(isSessionIdShaped(id)).toBe(true)
    expect(isSessionIdShaped(`${id}x`)).toBe(false)
    expect(isSessionIdShaped(id.slice(1))).toBe(false)
    expect(isSessionIdShaped('../../etc/passwd')).toBe(false)
    expect(isSessionIdShaped(undefined)).toBe(false)
  })

  it('reads the session out of a hostile Cookie header', () => {
    expect(sessionIdFromCookieHeader(`other=1; ${SESSION_COOKIE}=${id}; junk`)).toBe(id)
    expect(sessionIdFromCookieHeader(`${SESSION_COOKIE}=${id}; ${SESSION_COOKIE}=forged`)).toBe(id)
    expect(sessionIdFromCookieHeader(`${SESSION_COOKIE}=too-short`)).toBeNull()
    expect(sessionIdFromCookieHeader(null)).toBeNull()
    expect(sessionIdFromCookieHeader('')).toBeNull()
  })

  it('parses cookie pairs without choking on junk', () => {
    expect(parseCookies('a=1; b = 2 ;=3; nope; c=')).toEqual({ a: '1', b: '2', c: '' })
  })
})

describe('display names', () => {
  const base: GoogleIdTokenClaims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1',
    exp: NOW,
    iat: NOW,
    email: null,
    emailVerified: false,
    name: null,
    picture: null,
  }

  it('prefers the profile name', () => {
    expect(displayNameFromClaims({ ...base, name: '  Robb   Walters ' })).toBe('Robb Walters')
  })

  it('falls back to the email local part, never the domain', () => {
    expect(displayNameFromClaims({ ...base, email: 'robb@example.com' })).toBe('robb')
  })

  it('always produces something a buddy can be shown', () => {
    expect(displayNameFromClaims({ ...base, name: '   ', email: '@example.com' })).toBe(
      'Nugg Buddy',
    )
  })

  it('clips to the protocol ceiling', () => {
    expect(clampDisplayName(`  ${'x'.repeat(200)}`)).toHaveLength(40)
    expect(clampDisplayName('   ')).toBeNull()
  })
})

describe('buildGoogleAuthorizeUrl', () => {
  it('requests a PKCE S256 code flow with our state', () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: CLIENT_ID,
        redirectUri: 'https://nuggbudz.example/api/auth/google/callback',
        state: 's'.repeat(43),
        codeChallenge: 'c'.repeat(43),
        nonce: 'n'.repeat(22),
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('c'.repeat(43))
    expect(url.searchParams.get('state')).toBe('s'.repeat(43))
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('nonce')).toBe('n'.repeat(22))
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://nuggbudz.example/api/auth/google/callback',
    )
  })

  it('omits the nonce when none was generated', () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: CLIENT_ID,
        redirectUri: 'https://nuggbudz.example/cb',
        state: 's',
        codeChallenge: 'c',
      }),
    )
    expect(url.searchParams.has('nonce')).toBe(false)
  })
})

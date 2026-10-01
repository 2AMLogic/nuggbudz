import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_ENDPOINT,
  isSessionIdShaped,
  parsePendingAuthRecord,
  parseSessionRecord,
  sessionIdFromCookieHeader,
} from '../shared/auth'
import app from '../worker/index'
import {
  type FakeKv,
  fakeDb,
  fakeKv,
  makeSigner,
  type Signer,
  s256Challenge,
  segment,
  stubGoogle,
  tokenResponse,
} from './fixtures/oauth'

/**
 * The sign-in round trip, through the Worker's own routes.
 *
 * `test/jwt.test.ts` and `test/auth.test.ts` cover the pure predicates — the
 * `state` comparison, the claim checks, the signature. What nothing covered
 * until now is the *glue*: that the nonce `/google/start` mints is the nonce
 * that reaches the claim check, that the PKCE verifier it stashes is the one
 * the code exchange sends, and that the `pending:` record is single-use. #63
 * fixed exactly that class of defect — a value generated in one route and never
 * carried to the other — and its `nonce_mismatch` branch had a green unit test
 * while being unreachable for the whole life of #13.
 *
 * Nothing here stubs `verifyRs256Signature`. The token endpoint and the JWKS
 * endpoint are stand-ins; the signature over the token a stand-in returns is
 * real RSA, made by a throwaway keypair whose public JWK the stand-in JWKS
 * publishes. A harness that faked the signature check would stay green on a
 * Worker that had stopped making it.
 */

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-not-a-real-secret'
const ORIGIN = 'http://localhost'
const CALLBACK = `${ORIGIN}/api/auth/google/callback`
const USER_ID = '7f1b6a2e-0000-4000-8000-000000000001'
const GOOGLE_SUB = '108423991242'
const KID = 'google-key-1'

let google: Signer
let attacker: Signer

beforeAll(async () => {
  google = await makeSigner(KID)
  // Same `kid`, different key: a published-key check is the only thing that
  // tells these two apart.
  attacker = await makeSigner(KID)
}, 30_000)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The `Env` the auth routes read: KV for pending/session records, D1 for the upsert. */
function env(kv: FakeKv, db = fakeDb(USER_ID).db) {
  return {
    SESSIONS: kv.kv,
    DB: db,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  }
}

/** Google-shaped ID token claims, live by the Worker's own clock. */
function claims(nonce: string | undefined, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: GOOGLE_SUB,
    exp: now + 3600,
    iat: now - 5,
    email: 'robb@example.com',
    email_verified: true,
    name: 'Robb W',
    picture: 'https://lh3.googleusercontent.com/a/robb',
    ...(nonce === undefined ? {} : { nonce }),
    ...overrides,
  }
}

interface StartedSignIn {
  state: string
  nonce: string
  codeChallenge: string
}

/**
 * Drive `/google/start` and report what the authorize URL carried.
 *
 * Deliberately reads `state` and `nonce` off the `Location` header rather than
 * out of KV: those are the values Google is told, and the point of the round
 * trip is that the stashed record agrees with them.
 */
async function start(kv: FakeKv): Promise<StartedSignIn> {
  const response = await app.request(
    new Request(`${ORIGIN}/api/auth/google/start`),
    undefined,
    env(kv),
  )
  expect(response.status).toBe(302)
  const location = response.headers.get('Location')
  expect(location).not.toBeNull()
  const url = new URL(String(location))
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')

  const state = url.searchParams.get('state')
  const nonce = url.searchParams.get('nonce')
  const codeChallenge = url.searchParams.get('code_challenge')
  expect(state).toBeTruthy()
  expect(nonce).toBeTruthy()
  expect(codeChallenge).toBeTruthy()
  return { state: String(state), nonce: String(nonce), codeChallenge: String(codeChallenge) }
}

/** The `pending:<state>` record as `/google/start` left it in KV. */
function pendingRecord(kv: FakeKv, state: string) {
  const raw = kv.entries.get(`pending:${state}`)
  expect(raw).toBeDefined()
  return parsePendingAuthRecord(JSON.parse(String(raw)))
}

describe('GET /api/auth/google/start', () => {
  it('stashes a pending record agreeing with the authorize URL it sent', async () => {
    const kv = fakeKv()
    const { state, nonce, codeChallenge } = await start(kv)

    const pending = pendingRecord(kv, state)
    expect(pending).not.toBeNull()
    if (pending === null) return
    expect(pending.state).toBe(state)
    // The nonce the browser carries to Google and the nonce the callback will
    // check against are one value, which is the whole of #14.
    expect(pending.nonce).toBe(nonce)
    expect(pending.redirectUri).toBe(CALLBACK)
    // The verifier is never sent to /authorize — its challenge is — so this is
    // the only way to show the stashed verifier is the one PKCE committed to.
    expect(await s256Challenge(pending.codeVerifier)).toBe(codeChallenge)
  })

  it('answers 503 rather than redirecting when Google is not configured', async () => {
    const kv = fakeKv()
    const response = await app.request(new Request(`${ORIGIN}/api/auth/google/start`), undefined, {
      SESSIONS: kv.kv,
    })
    expect(response.status).toBe(503)
    expect(kv.entries.size).toBe(0)
  })
})

describe('GET /api/auth/google/callback', () => {
  it('signs in a buyer whose token echoes the stashed nonce', async () => {
    const kv = fakeKv()
    const { state, nonce } = await start(kv)
    const pending = pendingRecord(kv, state)
    if (pending === null) throw new Error('unreachable')

    const idToken = await google.sign({ alg: 'RS256', kid: KID }, claims(nonce))
    const stub = stubGoogle({ jwks: [google.jwk], token: tokenResponse(idToken) })
    vi.stubGlobal('fetch', stub.fetchImpl)
    const upsert = fakeDb(USER_ID)

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-1`),
      undefined,
      env(kv, upsert.db),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/')

    // The code exchange carried the stashed verifier and the stashed redirect,
    // not values re-derived at callback time.
    const exchange = stub.calls.find((call) => call.url === GOOGLE_TOKEN_ENDPOINT)
    expect(exchange?.body?.get('code')).toBe('auth-code-1')
    expect(exchange?.body?.get('code_verifier')).toBe(pending.codeVerifier)
    expect(exchange?.body?.get('redirect_uri')).toBe(pending.redirectUri)
    expect(exchange?.body?.get('client_secret')).toBe(CLIENT_SECRET)
    // The signature was verified against a key actually fetched from the JWKS.
    expect(stub.calls.some((call) => call.url === GOOGLE_JWKS_URL)).toBe(true)

    // The user was upserted on `google_sub`, and the session points at the row.
    expect(upsert.calls).toHaveLength(1)
    expect(upsert.calls[0]?.params).toContain(GOOGLE_SUB)

    const cookie = response.headers.get('Set-Cookie')
    const sessionId = sessionIdFromCookieHeader(cookie)
    expect(isSessionIdShaped(sessionId)).toBe(true)
    expect(cookie).toContain('HttpOnly')
    const stored = kv.entries.get(`session:${sessionId}`)
    const session = parseSessionRecord(JSON.parse(String(stored)))
    expect(session?.userId).toBe(USER_ID)
    expect(session?.googleSub).toBe(GOOGLE_SUB)
    expect(session?.displayName).toBe('Robb W')

    // And the half-finished sign-in is gone, exactly once.
    expect(kv.deletes).toEqual([`pending:${state}`])
    expect(kv.entries.has(`pending:${state}`)).toBe(false)
  })

  it('rejects a token minted against a different nonce', async () => {
    const kv = fakeKv()
    const { state, nonce } = await start(kv)
    // A token Google would happily issue — for a sign-in somebody else started.
    const idToken = await google.sign({ alg: 'RS256', kid: KID }, claims(`${nonce}-elsewhere`))
    vi.stubGlobal(
      'fetch',
      stubGoogle({ jwks: [google.jwk], token: tokenResponse(idToken) }).fetchImpl,
    )

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-2`),
      undefined,
      env(kv),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'nonce_mismatch' })
    expect(kv.deletes).toEqual([`pending:${state}`])
    // No session was minted on the way out.
    expect([...kv.entries.keys()].some((key) => key.startsWith('session:'))).toBe(false)
  })

  it('rejects a token carrying no nonce at all', async () => {
    const kv = fakeKv()
    const { state } = await start(kv)
    const idToken = await google.sign({ alg: 'RS256', kid: KID }, claims(undefined))
    vi.stubGlobal(
      'fetch',
      stubGoogle({ jwks: [google.jwk], token: tokenResponse(idToken) }).fetchImpl,
    )

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-3`),
      undefined,
      env(kv),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'nonce_mismatch' })
  })

  it('checks the signature before the claims, so a forgery is never read', async () => {
    const kv = fakeKv()
    const { state, nonce } = await start(kv)
    // Everything a claim check would accept, signed by somebody who is not Google.
    const idToken = await attacker.sign({ alg: 'RS256', kid: KID }, claims(nonce))
    vi.stubGlobal(
      'fetch',
      stubGoogle({ jwks: [google.jwk], token: tokenResponse(idToken) }).fetchImpl,
    )

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-4`),
      undefined,
      env(kv),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'bad_signature' })
  })

  it('refuses a token whose key the JWKS does not publish', async () => {
    const kv = fakeKv()
    const { state, nonce } = await start(kv)
    const idToken = await google.sign({ alg: 'RS256', kid: KID }, claims(nonce))
    // The real signer, but a JWKS that does not know it: the positive control on
    // the harness itself. If this passed, the signature check would be decoration.
    vi.stubGlobal(
      'fetch',
      stubGoogle({ jwks: [attacker.jwk], token: tokenResponse(idToken) }).fetchImpl,
    )

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-5`),
      undefined,
      env(kv),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'bad_signature' })
  })

  it('treats a replayed callback as an unknown state', async () => {
    const kv = fakeKv()
    const { state, nonce } = await start(kv)
    const idToken = await google.sign({ alg: 'RS256', kid: KID }, claims(nonce))
    const stub = stubGoogle({ jwks: [google.jwk], token: tokenResponse(idToken) })
    vi.stubGlobal('fetch', stub.fetchImpl)

    const callback = () =>
      app.request(
        new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-6`),
        undefined,
        env(kv),
      )

    expect((await callback()).status).toBe(302)
    const exchanges = stub.calls.filter((call) => call.url === GOOGLE_TOKEN_ENDPOINT).length

    // A second trip through the same URL — a refresh, a back button, or somebody
    // replaying a redirect they captured — finds nothing to verify against.
    const replay = await callback()
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ reason: 'unknown_state' })
    expect(replay.headers.get('Set-Cookie')).toBeNull()
    // And it never reached Google: the state is spent before the code is read.
    expect(stub.calls.filter((call) => call.url === GOOGLE_TOKEN_ENDPOINT)).toHaveLength(exchanges)
    expect(kv.deletes).toEqual([`pending:${state}`, `pending:${state}`])
  })

  it('refuses a nonce-less pending record rather than signing in without the check', async () => {
    const kv = fakeKv()
    // A record written by a deployment that predates #63 and still live in KV
    // when the nonce-checking code ships. `parsePendingAuthRecord` requires a
    // nonce, so this is an unknown state — never a 500, and never a sign-in
    // whose nonce check was silently skipped.
    const state = 'L'.repeat(43)
    kv.entries.set(
      `pending:${state}`,
      JSON.stringify({
        state,
        codeVerifier: 'v'.repeat(43),
        redirectUri: CALLBACK,
        createdAt: Date.now(),
      }),
    )
    const stub = stubGoogle({ jwks: [google.jwk], token: tokenResponse('never-minted') })
    vi.stubGlobal('fetch', stub.fetchImpl)

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-7`),
      undefined,
      env(kv),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ reason: 'unknown_state' })
    expect(stub.calls).toEqual([])
    // Still single-use: a record it refuses to honour is a record it clears.
    expect(kv.deletes).toEqual([`pending:${state}`])
  })

  it('answers a declined consent screen as a 400, without spending a state', async () => {
    const kv = fakeKv()
    const { state } = await start(kv)
    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&error=access_denied`),
      undefined,
      env(kv),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ detail: 'access_denied' })
  })

  it('refuses a malformed token the exchange handed back', async () => {
    const kv = fakeKv()
    const { state } = await start(kv)
    // Well-formed base64url segments, no signature worth the name.
    const junk = `${segment({ alg: 'RS256', kid: KID })}.${segment({ sub: '1' })}`
    vi.stubGlobal('fetch', stubGoogle({ jwks: [google.jwk], token: tokenResponse(junk) }).fetchImpl)

    const response = await app.request(
      new Request(`${ORIGIN}/api/auth/google/callback?state=${state}&code=auth-code-8`),
      undefined,
      env(kv),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'malformed_token' })
  })
})

import { Hono } from 'hono'
import {
  buildGoogleAuthorizeUrl,
  checkAuthState,
  checkGoogleIdTokenClaims,
  clampDisplayName,
  clearedSessionCookie,
  displayNameFromClaims,
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_ENDPOINT,
  type GoogleIdTokenClaims,
  PENDING_AUTH_TTL_SECONDS,
  type PendingAuthRecord,
  parsePendingAuthRecord,
  parseSessionRecord,
  publicUser,
  SESSION_TTL_SECONDS,
  type SessionRecord,
  sessionCookie,
  sessionIdFromCookieHeader,
} from '../shared/auth'
import { bytesToBase64Url } from '../shared/base64url'
import { parseJwks, parseJwt, type RsaPublicJwk, verifyRs256Signature } from '../shared/jwt'
import type { Env } from './env'

/**
 * Google sign-in, Authorization Code + PKCE, terminating here.
 *
 * The browser never sees a token: it gets an opaque session id in an HttpOnly
 * cookie, and the session lives in KV. That keeps the client secret and the ID
 * token server-side, and makes revocation a single KV delete.
 *
 * The pure decision logic — `state` comparison, claim checks, cookie shapes —
 * is in `shared/auth.ts`; this module is the I/O around it.
 */
export const authRoutes = new Hono<{ Bindings: Env }>()

const JWKS_CACHE_KEY = 'jwks:google'
/** Google rotates signing keys on the order of days; an hour of cache is safe. */
const JWKS_CACHE_TTL_SECONDS = 3600

interface GoogleConfig {
  clientId: string
  clientSecret: string
}

function googleConfig(env: Env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? ''
  if (clientId.length === 0 || clientSecret.length === 0) return null
  return { clientId, clientSecret }
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return bytesToBase64Url(new Uint8Array(digest))
}

/**
 * The callback URL, derived from the request rather than configured, so the
 * same deployment works on a preview hostname and in local dev. `PUBLIC_ORIGIN`
 * overrides it when the Worker sits behind something that rewrites the host.
 */
function redirectUri(env: Env, requestUrl: string): string {
  const origin = env.PUBLIC_ORIGIN?.trim()
  const base = origin !== undefined && origin.length > 0 ? origin : new URL(requestUrl).origin
  return new URL('/api/auth/google/callback', base).toString()
}

/** Google's signing keys, cached in KV so every sign-in is not a round trip. */
async function googleJwks(env: Env): Promise<RsaPublicJwk[] | null> {
  const cached = await env.SESSIONS.get(JWKS_CACHE_KEY, 'json')
  const fromCache = parseJwks(cached)
  if (fromCache !== null) return fromCache

  const response = await fetch(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) return null
  const body: unknown = await response.json().catch(() => null)
  const jwks = parseJwks(body)
  if (jwks === null) return null

  await env.SESSIONS.put(JWKS_CACHE_KEY, JSON.stringify({ keys: jwks }), {
    expirationTtl: JWKS_CACHE_TTL_SECONDS,
  })
  return jwks
}

export interface ActiveSession {
  sessionId: string
  session: SessionRecord
}

/**
 * Resolve the caller's session from their cookie, or null.
 *
 * The cookie value is only ever a lookup key — nothing about the user is read
 * out of it — so a forged cookie is a KV miss rather than an identity claim.
 */
export async function sessionFromRequest(
  env: Env,
  request: Request,
): Promise<ActiveSession | null> {
  const sessionId = sessionIdFromCookieHeader(request.headers.get('Cookie'))
  if (sessionId === null) return null
  const stored = await env.SESSIONS.get(`session:${sessionId}`, 'json')
  const session = parseSessionRecord(stored)
  if (session === null) return null
  return { sessionId, session }
}

authRoutes.get('/google/start', async (c) => {
  const config = googleConfig(c.env)
  if (config === null) return c.json({ error: 'google sign-in is not configured' }, 503)

  const state = randomBase64Url(32)
  // PKCE verifier: 32 random bytes is 43 base64url chars, within RFC 7636's 43..128.
  const codeVerifier = randomBase64Url(32)
  const callback = redirectUri(c.env, c.req.url)

  await c.env.SESSIONS.put(
    `pending:${state}`,
    JSON.stringify({ state, codeVerifier, redirectUri: callback, createdAt: Date.now() }),
    { expirationTtl: PENDING_AUTH_TTL_SECONDS },
  )

  return c.redirect(
    buildGoogleAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: callback,
      state,
      codeChallenge: await s256Challenge(codeVerifier),
      nonce: randomBase64Url(16),
    }),
    302,
  )
})

authRoutes.get('/google/callback', async (c) => {
  const config = googleConfig(c.env)
  if (config === null) return c.json({ error: 'google sign-in is not configured' }, 503)

  // Google reports a declined consent screen as a query parameter, not an error
  // status. Surface it as a 400 rather than letting it fall through as a 500.
  const denied = c.req.query('error')
  if (denied !== undefined) {
    return c.json({ error: 'google sign-in was declined', detail: denied }, 400)
  }

  const rawState = c.req.query('state')
  const stored = await c.env.SESSIONS.get(`pending:${rawState ?? ''}`, 'json')
  const pending = parsePendingAuthRecord(stored)
  // Single use, whatever happens next: a replayed callback finds nothing.
  if (rawState !== undefined) await c.env.SESSIONS.delete(`pending:${rawState}`)

  const stateCheck = checkAuthState(rawState, pending)
  if (!stateCheck.ok) {
    return c.json(
      { error: 'sign-in request could not be verified', reason: stateCheck.reason },
      400,
    )
  }

  const code = c.req.query('code')
  if (code === undefined || code.length === 0) {
    return c.json({ error: 'missing authorization code' }, 400)
  }

  const idToken = await exchangeCode(config, code, stateCheck.pending)
  if (idToken === null) {
    // An expired or already-used code lands here: Google answers `invalid_grant`.
    return c.json({ error: 'authorization code could not be exchanged' }, 400)
  }

  const claims = await verifyIdToken(c.env, idToken, config.clientId)
  if (!claims.ok) return c.json({ error: 'id token rejected', reason: claims.reason }, 401)

  const session = await upsertUser(c.env, claims.claims)
  const sessionId = randomBase64Url(32)
  await c.env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  })

  c.header('Set-Cookie', sessionCookie(sessionId))
  return c.redirect('/', 302)
})

authRoutes.get('/me', async (c) => {
  const active = await sessionFromRequest(c.env, c.req.raw)
  if (active === null) return c.json({ error: 'not signed in' }, 401)
  return c.json({ user: publicUser(active.session) })
})

authRoutes.post('/logout', async (c) => {
  const active = await sessionFromRequest(c.env, c.req.raw)
  if (active !== null) await c.env.SESSIONS.delete(`session:${active.sessionId}`)
  c.header('Set-Cookie', clearedSessionCookie())
  return c.json({ ok: true })
})

/** Exchange the code for an ID token. Returns null on any non-happy path. */
async function exchangeCode(
  config: GoogleConfig,
  code: string,
  pending: PendingAuthRecord,
): Promise<string | null> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      // PKCE: proves this exchange comes from whoever started the sign-in, even
      // if the code leaked out of the redirect.
      code_verifier: pending.codeVerifier,
      grant_type: 'authorization_code',
      // Must be byte-identical to the one sent to /authorize, so it comes back
      // out of the pending record rather than being re-derived here.
      redirect_uri: pending.redirectUri,
    }),
  })
  if (!response.ok) return null

  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) return null
  const idToken = (body as Record<string, unknown>).id_token
  return typeof idToken === 'string' && idToken.length > 0 ? idToken : null
}

export type IdTokenCheck = { ok: true; claims: GoogleIdTokenClaims } | { ok: false; reason: string }

/**
 * Verify an ID token end to end: signature against Google's JWKS first, then
 * the claims. Decoding alone would accept a token anybody could have written.
 */
async function verifyIdToken(env: Env, idToken: string, clientId: string): Promise<IdTokenCheck> {
  const parsed = parseJwt(idToken)
  if (parsed === null) return { ok: false, reason: 'malformed_token' }

  const jwks = await googleJwks(env)
  if (jwks === null) return { ok: false, reason: 'jwks_unavailable' }

  const verified = await verifyRs256Signature(parsed, jwks, crypto.subtle)
  if (!verified) return { ok: false, reason: 'bad_signature' }

  const check = checkGoogleIdTokenClaims(parsed.claims, {
    clientId,
    now: Math.floor(Date.now() / 1000),
  })
  return check.ok ? { ok: true, claims: check.claims } : { ok: false, reason: check.reason }
}

/**
 * Upsert the user on `google_sub` and return the session to mint.
 *
 * `google_sub` is the join key rather than the email, because a Google account
 * can change its email address and the subject never changes.
 */
async function upsertUser(env: Env, claims: GoogleIdTokenClaims): Promise<SessionRecord> {
  const displayName = displayNameFromClaims(claims)
  const now = Date.now()
  const row = await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (google_sub) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at
     RETURNING id`,
  )
    .bind(crypto.randomUUID(), claims.sub, claims.email, displayName, claims.picture, now)
    .first<{ id: string }>()

  if (row === null) throw new Error('user upsert returned no row')

  return {
    userId: row.id,
    googleSub: claims.sub,
    displayName: clampDisplayName(displayName) ?? 'Nugg Buddy',
    email: claims.email,
    avatarUrl: claims.picture,
    createdAt: now,
  }
}

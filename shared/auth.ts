/**
 * Google sign-in: the parts that are pure.
 *
 * Everything here is decision logic over untrusted input — the `state` a
 * browser hands back, the claims inside an ID token, the cookie header on a
 * socket upgrade — so it lives in `shared/` and is unit-testable without a
 * Workers runtime. The I/O half (redirects, code exchange, JWKS fetch, KV) is
 * in `worker/auth.ts`.
 */

/** Google mints tokens under both spellings of its issuer. Accept exactly these. */
export const GOOGLE_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
]

export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/** Clock skew allowance on `exp`/`iat`, in seconds. */
export const CLOCK_LEEWAY_SECONDS = 60

export const SESSION_COOKIE = 'nb_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
/** A sign-in attempt is a few seconds of human time; ten minutes is generous. */
export const PENDING_AUTH_TTL_SECONDS = 600
/** Matches the display-name ceiling the pairing protocol enforces. */
export const MAX_DISPLAY_NAME = 40

export interface GoogleIdTokenClaims {
  iss: string
  aud: string
  sub: string
  exp: number
  iat: number
  email: string | null
  emailVerified: boolean
  name: string | null
  picture: string | null
}

export type ClaimRejection =
  | 'malformed_claims'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'issued_in_future'
  | 'nonce_mismatch'

export type ClaimCheck =
  | { ok: true; claims: GoogleIdTokenClaims }
  | { ok: false; reason: ClaimRejection }

export interface ClaimCheckOptions {
  /** Our OAuth client id. The token's `aud` must be exactly this. */
  clientId: string
  /** Current time in unix *seconds*, matching JWT convention. */
  now: number
  leewaySeconds?: number
  /** Expected `nonce`, when the authorize request sent one. */
  nonce?: string
}

/**
 * Validate the claims of an already-signature-verified Google ID token.
 *
 * Signature verification proves Google issued the token; these checks prove it
 * was issued *to us* and is still live. A token minted for another client id is
 * a perfectly valid Google token and a complete authentication bypass if `aud`
 * is not checked, which is why that check is not optional.
 */
export function checkGoogleIdTokenClaims(raw: unknown, options: ClaimCheckOptions): ClaimCheck {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'malformed_claims' }
  const claims = raw as Record<string, unknown>

  const { iss, sub, exp, iat } = claims
  if (typeof iss !== 'string') return { ok: false, reason: 'malformed_claims' }
  if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'malformed_claims' }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { ok: false, reason: 'malformed_claims' }
  }
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    return { ok: false, reason: 'malformed_claims' }
  }

  const aud = normalizeAudience(claims.aud)
  if (aud === null) return { ok: false, reason: 'malformed_claims' }

  if (!GOOGLE_ISSUERS.includes(iss)) return { ok: false, reason: 'bad_issuer' }
  if (options.clientId.length === 0 || !aud.includes(options.clientId)) {
    return { ok: false, reason: 'bad_audience' }
  }

  const leeway = options.leewaySeconds ?? CLOCK_LEEWAY_SECONDS
  if (exp + leeway <= options.now) return { ok: false, reason: 'expired' }
  if (iat - leeway > options.now) return { ok: false, reason: 'issued_in_future' }

  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    return { ok: false, reason: 'nonce_mismatch' }
  }

  return {
    ok: true,
    claims: {
      iss,
      // The token is single-audience for our purposes: the one that matched.
      aud: options.clientId,
      sub,
      exp,
      iat,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : null,
      picture: typeof claims.picture === 'string' ? claims.picture : null,
    },
  }
}

/** `aud` is a string or an array of strings per RFC 7519; Google sends a string. */
function normalizeAudience(raw: unknown): string[] | null {
  if (typeof raw === 'string') return raw.length === 0 ? null : [raw]
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) return null
    out.push(entry)
  }
  return out
}

/** The half-finished sign-in stashed in KV between `start` and `callback`. */
export interface PendingAuthRecord {
  state: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
}

export function parsePendingAuthRecord(raw: unknown): PendingAuthRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const { state, codeVerifier, redirectUri, createdAt } = record
  if (typeof state !== 'string' || state.length === 0) return null
  if (typeof codeVerifier !== 'string' || codeVerifier.length < 43) return null
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  return { state, codeVerifier, redirectUri, createdAt }
}

export type StateRejection = 'missing_state' | 'unknown_state' | 'state_mismatch'

export type StateCheck =
  | { ok: true; pending: PendingAuthRecord }
  | { ok: false; reason: StateRejection }

/**
 * Check the `state` a browser came back with against the one we stashed.
 *
 * `state` is the entire CSRF defence for the callback: without it an attacker
 * can walk a victim's browser through a callback carrying the attacker's code
 * and silently log the victim into the attacker's account.
 */
export function checkAuthState(received: unknown, pending: PendingAuthRecord | null): StateCheck {
  if (typeof received !== 'string' || received.length < 16) {
    return { ok: false, reason: 'missing_state' }
  }
  if (pending === null) return { ok: false, reason: 'unknown_state' }
  if (!timingSafeEqual(received, pending.state)) return { ok: false, reason: 'state_mismatch' }
  return { ok: true, pending }
}

/**
 * Length-independent, content-constant-time string comparison.
 *
 * Both `state` and session ids are secrets compared against attacker-supplied
 * values, so the comparison must not leak a prefix length by returning early.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0)
  }
  return diff === 0
}

export interface SessionRecord {
  userId: string
  googleSub: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  createdAt: number
}

export function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const { userId, googleSub, displayName, createdAt } = record
  if (typeof userId !== 'string' || userId.length === 0) return null
  if (typeof googleSub !== 'string' || googleSub.length === 0) return null
  if (typeof displayName !== 'string') return null
  const name = clampDisplayName(displayName)
  if (name === null) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  return {
    userId,
    googleSub,
    displayName: name,
    email: typeof record.email === 'string' ? record.email : null,
    avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : null,
    createdAt,
  }
}

/** Session ids are 32 random bytes rendered base64url: 43 chars, no padding. */
export const SESSION_ID_LENGTH = 43

export function isSessionIdShaped(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length === SESSION_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(raw)
}

/**
 * The session cookie.
 *
 * `HttpOnly` keeps it away from script, `Secure` off plaintext hops, and
 * `SameSite=Lax` still lets Google's top-level redirect back into the callback
 * carry it — `Strict` would drop the cookie on exactly that navigation.
 */
export function sessionCookie(sessionId: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

/** Parse a `Cookie` header. Hostile input: never throws, ignores junk pairs. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof header !== 'string' || header.length === 0) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name.length === 0) continue
    const value = part.slice(eq + 1).trim()
    // First occurrence wins, so a later duplicate cannot shadow the real cookie.
    if (!(name in out)) out[name] = value
  }
  return out
}

export function sessionIdFromCookieHeader(header: string | null | undefined): string | null {
  const value = parseCookies(header)[SESSION_COOKIE]
  return isSessionIdShaped(value) ? value : null
}

/** Trim and clip a display name, or null if nothing usable is left. */
export function clampDisplayName(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return null
  return trimmed.slice(0, MAX_DISPLAY_NAME)
}

/**
 * The name a buddy sees. Prefer Google's profile name, fall back to the local
 * part of the email, and never fall back to something that identifies the user
 * more than they chose to share.
 */
export function displayNameFromClaims(claims: GoogleIdTokenClaims): string {
  const fromName = claims.name === null ? null : clampDisplayName(claims.name)
  if (fromName !== null) return fromName
  if (claims.email !== null) {
    const local = clampDisplayName(claims.email.split('@')[0] ?? '')
    if (local !== null) return local
  }
  return 'Nugg Buddy'
}

export interface AuthorizeUrlOptions {
  clientId: string
  redirectUri: string
  state: string
  /** base64url(SHA-256(code_verifier)) — PKCE S256. */
  codeChallenge: string
  nonce?: string
  scope?: string
}

/** Google's authorize URL. Pure string building, so the query is testable. */
export function buildGoogleAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', options.scope ?? 'openid email profile')
  url.searchParams.set('state', options.state)
  url.searchParams.set('code_challenge', options.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // Ask for no refresh token: this app never acts on Google's behalf offline.
  url.searchParams.set('access_type', 'online')
  if (options.nonce !== undefined) url.searchParams.set('nonce', options.nonce)
  return url.toString()
}

/** The public shape of a signed-in user, safe to hand to the client. */
export interface PublicUser {
  id: string
  displayName: string
  email: string | null
  avatarUrl: string | null
}

export function publicUser(session: SessionRecord): PublicUser {
  return {
    id: session.userId,
    displayName: session.displayName,
    email: session.email,
    avatarUrl: session.avatarUrl,
  }
}

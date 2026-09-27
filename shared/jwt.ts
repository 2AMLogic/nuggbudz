/**
 * Just enough JWT to verify a Google ID token, and nothing more.
 *
 * Decoding a token tells you what its author claims; only verifying the
 * signature tells you Google said it. Both halves live here, and both are pure:
 * the signature check takes the Web Crypto subtle interface as an argument
 * (narrowed to the two methods it uses) so `shared/` keeps no runtime binding
 * and the verifier is testable in plain Node.
 */
import { base64UrlToBytes, base64UrlToString } from './base64url'

export interface JwtHeader {
  alg: string
  kid?: string
}

export interface ParsedJwt {
  header: JwtHeader
  /** Raw claims. Still untrusted at this point — the signature is unchecked. */
  claims: Record<string, unknown>
  /** The exact `header.payload` bytes the signature covers. */
  signingInput: Uint8Array<ArrayBuffer>
  signature: Uint8Array<ArrayBuffer>
}

/** An RSA public key as published in a JWKS document. */
export interface RsaPublicJwk {
  kty: 'RSA'
  n: string
  e: string
  kid?: string
  alg?: string
}

/**
 * The slice of `SubtleCrypto` the verifier needs.
 *
 * Declared here rather than imported so this module does not depend on DOM or
 * Workers type libraries; pass `crypto.subtle` from either runtime.
 */
export interface JwtSubtleCrypto<Key = unknown> {
  importKey(
    format: 'jwk',
    keyData: RsaPublicJwk,
    algorithm: { name: 'RSASSA-PKCS1-v1_5'; hash: 'SHA-256' },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<Key>
  verify(
    algorithm: { name: 'RSASSA-PKCS1-v1_5' },
    key: Key,
    signature: Uint8Array<ArrayBuffer>,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<boolean>
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** JWT compact serialization is ASCII by construction, which `BASE64URL` enforces. */
function asciiBytes(input: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i)
  return out
}

/**
 * Split and decode a compact JWS. Returns null for anything malformed rather
 * than throwing, because the input is attacker-controlled.
 */
export function parseJwt(token: unknown): ParsedJwt | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSignature] = parts
  if (!BASE64URL.test(rawHeader) || !BASE64URL.test(rawPayload)) return null
  if (!BASE64URL.test(rawSignature)) return null

  const header = decodeJsonObject(rawHeader)
  if (header === null) return null
  if (typeof header.alg !== 'string') return null
  if (header.kid !== undefined && typeof header.kid !== 'string') return null

  const claims = decodeJsonObject(rawPayload)
  if (claims === null) return null

  const signature = base64UrlToBytes(rawSignature)
  if (signature === null || signature.length === 0) return null

  return {
    header: { alg: header.alg, kid: header.kid as string | undefined },
    claims,
    signingInput: asciiBytes(`${rawHeader}.${rawPayload}`),
    signature,
  }
}

function decodeJsonObject(segment: string): Record<string, unknown> | null {
  const text = base64UrlToString(segment)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** Narrow a fetched JWKS document to the RSA keys this verifier can use. */
export function parseJwks(raw: unknown): RsaPublicJwk[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const keys = (raw as Record<string, unknown>).keys
  if (!Array.isArray(keys)) return null

  const out: RsaPublicJwk[] = []
  for (const candidate of keys) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const key = candidate as Record<string, unknown>
    if (key.kty !== 'RSA') continue
    if (typeof key.n !== 'string' || typeof key.e !== 'string') continue
    if (key.alg !== undefined && key.alg !== 'RS256') continue
    if (key.kid !== undefined && typeof key.kid !== 'string') continue
    out.push({
      kty: 'RSA',
      n: key.n,
      e: key.e,
      kid: key.kid as string | undefined,
      alg: 'RS256',
    })
  }
  return out.length === 0 ? null : out
}

/**
 * Pick the signing key. A `kid` must match exactly; a token without one is only
 * resolvable when the issuer publishes a single key.
 */
export function findJwk(
  jwks: readonly RsaPublicJwk[],
  kid: string | undefined,
): RsaPublicJwk | null {
  if (kid === undefined) return jwks.length === 1 ? jwks[0] : null
  return jwks.find((key) => key.kid === kid) ?? null
}

/**
 * Verify an RS256 signature against a JWKS.
 *
 * Returns false — never throws — on an unknown `kid`, an unsupported `alg` or a
 * bad signature, so every rejection funnels through one branch at the call site.
 */
export async function verifyRs256Signature(
  parsed: ParsedJwt,
  jwks: readonly RsaPublicJwk[],
  subtle: JwtSubtleCrypto,
): Promise<boolean> {
  // `alg: none` and HMAC substitution are the classic JWT forgeries: an issuer
  // key is an RSA key, so anything but RS256 is rejected before a key is loaded.
  if (parsed.header.alg !== 'RS256') return false
  const jwk = findJwk(jwks, parsed.header.kid)
  if (jwk === null) return false

  try {
    const key = await subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return await subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      parsed.signature,
      parsed.signingInput,
    )
  } catch {
    return false
  }
}

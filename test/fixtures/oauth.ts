/**
 * The Worker-shaped half of the sign-in harness.
 *
 * `shared/auth.ts` is pure and tests itself; the *route glue* in
 * `worker/auth.ts` needs an `Env` to run against — a KV namespace, a D1 binding
 * and a `fetch` that answers Google. This module is that, and nothing more. It
 * lives in `test/` rather than `shared/` for the obvious reason: it names
 * Workers types, which `shared/` must never do.
 *
 * The one thing it deliberately does **not** provide is a stand-in for
 * signature verification. `makeSigner` mints a real throwaway RSA keypair and
 * `publishJwks` serves that keypair's public JWK, so `verifyRs256Signature`
 * runs for real on every token this harness produces. A harness that stubbed
 * the signature check would be worse than no harness: it would be green on a
 * Worker that had stopped checking signatures at all.
 */

import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_ENDPOINT } from '../../shared/auth'
import { bytesToBase64Url } from '../../shared/base64url'
import type { RsaPublicJwk } from '../../shared/jwt'

const encoder = new TextEncoder()
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

/** One base64url JWT segment: the encoding both the header and claims use. */
export function segment(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)))
}

export interface Signer {
  jwk: RsaPublicJwk
  sign: (header: Record<string, unknown>, claims: Record<string, unknown>) => Promise<string>
}

/** A throwaway RSA keypair, so the signature path is exercised for real. */
export async function makeSigner(kid: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
    n: string
    e: string
  }
  return {
    jwk: { kty: 'RSA', n: exported.n, e: exported.e, kid, alg: 'RS256' },
    async sign(header, claims) {
      const signingInput = `${segment({ ...header })}.${segment(claims)}`
      const signature = await crypto.subtle.sign(
        RS256.name,
        pair.privateKey,
        encoder.encode(signingInput),
      )
      return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`
    },
  }
}

/** PKCE S256, recomputed here so a test can check the challenge the URL carried. */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return bytesToBase64Url(new Uint8Array(digest))
}

export interface FakeKv {
  kv: KVNamespace
  /** Raw stored values, so a test can plant a record or read one back. */
  entries: Map<string, string>
  deletes: string[]
}

/**
 * A KV stand-in: a Map behind the three methods the auth routes use.
 *
 * `delete` calls are recorded rather than merely applied, because "deleted
 * exactly once, on every exit path" is a thing the callback promises.
 */
export function fakeKv(): FakeKv {
  const entries = new Map<string, string>()
  const deletes: string[] = []
  const kv = {
    async get(key: string, type?: unknown) {
      const raw = entries.get(key)
      if (raw === undefined) return null
      if (type !== 'json') return raw
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    },
    async put(key: string, value: string) {
      entries.set(key, value)
    },
    async delete(key: string) {
      deletes.push(key)
      entries.delete(key)
    },
  }
  return { kv: kv as unknown as KVNamespace, entries, deletes }
}

export interface FakeDb {
  db: D1Database
  /** Every `prepare().bind()` the Worker made, in order. */
  calls: { sql: string; params: unknown[] }[]
}

/**
 * A D1 stand-in covering `prepare().bind().first()` — the whole surface
 * `upsertUser` touches. `userId` is the `RETURNING id` row it answers with, so
 * a test can assert the session it mints points at that account.
 */
export function fakeDb(userId: string): FakeDb {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        calls.push({ sql, params })
        return { first: async () => ({ id: userId }) }
      },
    }),
  }
  return { db: db as unknown as D1Database, calls }
}

export interface GoogleStub {
  /** Every request the Worker made, so a test can read the exchange body back. */
  calls: { url: string; body: URLSearchParams | null }[]
  fetchImpl: typeof fetch
}

/**
 * The form body of an outbound call, however it was spelled.
 *
 * `fetch` accepts a `URLSearchParams` and a pre-encoded string indifferently,
 * and `exchangeCode` happens to pass the former — reading only one of the two
 * would make an assertion about the exchange silently vacuous.
 */
function formBody(raw: BodyInit | null | undefined): URLSearchParams | null {
  if (typeof raw === 'string') return new URLSearchParams(raw)
  if (raw instanceof URLSearchParams) return raw
  return null
}

export interface GoogleStubOptions {
  /** The keys the JWKS endpoint publishes. */
  jwks: RsaPublicJwk[]
  /** What the token endpoint answers with, per call. */
  token: () => Promise<Response> | Response
}

/**
 * A `fetch` answering the two Google endpoints `worker/auth.ts` reaches for, and
 * throwing on anything else — an unexpected outbound call is a finding, not a
 * default.
 */
export function stubGoogle(options: GoogleStubOptions): GoogleStub {
  const calls: { url: string; body: URLSearchParams | null }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: formBody(init?.body) })
    if (url === GOOGLE_TOKEN_ENDPOINT) return await options.token()
    if (url === GOOGLE_JWKS_URL) return Response.json({ keys: options.jwks })
    throw new Error(`unexpected outbound fetch: ${url}`)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/** A token-endpoint answer carrying an `id_token`, the way Google's does. */
export function tokenResponse(idToken: string): () => Response {
  return () => Response.json({ access_token: 'ignored', id_token: idToken, expires_in: 3599 })
}

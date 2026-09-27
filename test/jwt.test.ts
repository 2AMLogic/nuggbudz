import { beforeAll, describe, expect, it } from 'vitest'
import { base64UrlToBytes, base64UrlToString, bytesToBase64Url } from '../shared/base64url'
import {
  findJwk,
  parseJwks,
  parseJwt,
  type RsaPublicJwk,
  verifyRs256Signature,
} from '../shared/jwt'

const encoder = new TextEncoder()
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

function segment(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)))
}

interface Signer {
  jwk: RsaPublicJwk
  sign: (header: Record<string, unknown>, claims: Record<string, unknown>) => Promise<string>
}

/** A throwaway RSA keypair, so the signature path is exercised for real. */
async function makeSigner(kid: string): Promise<Signer> {
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

let google: Signer
let attacker: Signer

beforeAll(async () => {
  google = await makeSigner('google-key-1')
  attacker = await makeSigner('google-key-1')
}, 30_000)

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) % 256
      const encoded = bytesToBase64Url(bytes)
      expect(encoded).not.toContain('=')
      expect(encoded).not.toMatch(/[+/]/)
      expect(Array.from(base64UrlToBytes(encoded) ?? [])).toEqual(Array.from(bytes))
    }
  })

  it('decodes utf-8 payloads', () => {
    expect(base64UrlToString(bytesToBase64Url(encoder.encode('José 🍗')))).toBe('José 🍗')
  })

  it('rejects non-base64url input', () => {
    expect(base64UrlToBytes('a+b/c')).toBeNull()
    expect(base64UrlToBytes('abcde!')).toBeNull()
    // A lone trailing character cannot encode a byte.
    expect(base64UrlToBytes('abcdE')).toBeNull()
    expect(base64UrlToString('!!!!')).toBeNull()
  })
})

describe('parseJwt', () => {
  it('splits and decodes a well-formed token', async () => {
    const token = await google.sign({ alg: 'RS256', kid: 'google-key-1' }, { sub: '42' })
    const parsed = parseJwt(token)
    expect(parsed?.header).toEqual({ alg: 'RS256', kid: 'google-key-1' })
    expect(parsed?.claims).toEqual({ sub: '42' })
    expect(parsed?.signature.length).toBeGreaterThan(0)
  })

  it('returns null rather than throwing on hostile input', () => {
    expect(parseJwt(undefined)).toBeNull()
    expect(parseJwt(42)).toBeNull()
    expect(parseJwt('')).toBeNull()
    expect(parseJwt('a.b')).toBeNull()
    expect(parseJwt('a.b.c.d')).toBeNull()
    expect(parseJwt('!!.!!.!!')).toBeNull()
    // Valid base64url that is not JSON.
    expect(parseJwt(`${bytesToBase64Url(encoder.encode('nope'))}.${segment({})}.AAAA`)).toBeNull()
    // A JSON array is not a claim set.
    expect(parseJwt(`${segment({ alg: 'RS256' })}.${segment([1, 2])}.AAAA`)).toBeNull()
    // Header without an `alg`.
    expect(parseJwt(`${segment({ kid: 'k' })}.${segment({})}.AAAA`)).toBeNull()
  })
})

describe('parseJwks', () => {
  it('keeps usable RSA keys and drops the rest', () => {
    const parsed = parseJwks({
      keys: [
        { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        { kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'k1' },
        { kty: 'RSA', n: 123, e: 'AQAB', kid: 'k2' },
        { kty: 'RSA', n: 'def', e: 'AQAB', kid: 'k3', alg: 'RS512' },
      ],
    })
    expect(parsed).toEqual([{ kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'k1', alg: 'RS256' }])
  })

  it('returns null for junk', () => {
    expect(parseJwks(null)).toBeNull()
    expect(parseJwks({})).toBeNull()
    expect(parseJwks({ keys: 'nope' })).toBeNull()
    expect(parseJwks({ keys: [] })).toBeNull()
  })
})

describe('findJwk', () => {
  const keys: RsaPublicJwk[] = [
    { kty: 'RSA', n: 'a', e: 'AQAB', kid: 'k1' },
    { kty: 'RSA', n: 'b', e: 'AQAB', kid: 'k2' },
  ]

  it('matches on kid', () => {
    expect(findJwk(keys, 'k2')?.n).toBe('b')
    expect(findJwk(keys, 'k3')).toBeNull()
  })

  it('refuses to guess when a token omits kid and several keys are published', () => {
    expect(findJwk(keys, undefined)).toBeNull()
    expect(findJwk([keys[0]], undefined)?.n).toBe('a')
  })
})

describe('verifyRs256Signature', () => {
  const claims = { iss: 'https://accounts.google.com', sub: '108', aud: 'client-a' }

  it('accepts a token signed by the published key', async () => {
    const token = await google.sign({ alg: 'RS256', kid: 'google-key-1' }, claims)
    const parsed = parseJwt(token)
    expect(parsed).not.toBeNull()
    if (parsed === null) return
    expect(await verifyRs256Signature(parsed, [google.jwk], crypto.subtle)).toBe(true)
  })

  it('rejects a token signed by anybody else, even with a matching kid', async () => {
    const token = await attacker.sign({ alg: 'RS256', kid: 'google-key-1' }, claims)
    const parsed = parseJwt(token)
    if (parsed === null) throw new Error('unreachable')
    expect(await verifyRs256Signature(parsed, [google.jwk], crypto.subtle)).toBe(false)
  })

  it('rejects a tampered payload', async () => {
    const token = await google.sign({ alg: 'RS256', kid: 'google-key-1' }, claims)
    const [header, , signature] = token.split('.')
    const forged = `${header}.${segment({ ...claims, sub: 'somebody-else' })}.${signature}`
    const parsed = parseJwt(forged)
    if (parsed === null) throw new Error('unreachable')
    expect(await verifyRs256Signature(parsed, [google.jwk], crypto.subtle)).toBe(false)
  })

  it('rejects algorithms other than RS256, including none', async () => {
    const token = await google.sign({ alg: 'RS256', kid: 'google-key-1' }, claims)
    const [, payload, signature] = token.split('.')
    for (const alg of ['none', 'HS256', 'RS512']) {
      const parsed = parseJwt(`${segment({ alg, kid: 'google-key-1' })}.${payload}.${signature}`)
      if (parsed === null) throw new Error('unreachable')
      expect(await verifyRs256Signature(parsed, [google.jwk], crypto.subtle)).toBe(false)
    }
  })

  it('rejects an unknown kid without consulting a key', async () => {
    const token = await google.sign({ alg: 'RS256', kid: 'rotated-away' }, claims)
    const parsed = parseJwt(token)
    if (parsed === null) throw new Error('unreachable')
    expect(await verifyRs256Signature(parsed, [google.jwk], crypto.subtle)).toBe(false)
  })

  it('returns false instead of throwing on an unusable key', async () => {
    const token = await google.sign({ alg: 'RS256', kid: 'google-key-1' }, claims)
    const parsed = parseJwt(token)
    if (parsed === null) throw new Error('unreachable')
    const broken: RsaPublicJwk = { kty: 'RSA', n: 'not-a-modulus', e: 'AQAB', kid: 'google-key-1' }
    expect(await verifyRs256Signature(parsed, [broken], crypto.subtle)).toBe(false)
  })
})

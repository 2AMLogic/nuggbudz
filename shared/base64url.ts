/**
 * base64url codec.
 *
 * Hand-rolled rather than reaching for `atob`/`btoa` or `Buffer` because this
 * module is imported by the Worker, the tests and the client, and `shared/`
 * stays free of any one runtime's globals. It also lets the decoder reject a
 * malformed segment instead of silently coercing it, which matters when the
 * input is an attacker-supplied JWT.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const REVERSE = new Map<string, number>()
for (let i = 0; i < ALPHABET.length; i++) REVERSE.set(ALPHABET[i], i)

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i
    const b0 = bytes[i]
    const b1 = remaining > 1 ? bytes[i + 1] : 0
    const b2 = remaining > 2 ? bytes[i + 2] : 0

    out += ALPHABET[b0 >> 2]
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    if (remaining > 1) out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
    if (remaining > 2) out += ALPHABET[b2 & 0x3f]
  }
  return out
}

/**
 * Decode base64url, returning null for anything that is not valid base64url.
 *
 * The `Uint8Array<ArrayBuffer>` return type is deliberate rather than a bare
 * `Uint8Array`: Web Crypto's `BufferSource` excludes views over a
 * `SharedArrayBuffer`, so the narrower type is what lets these bytes be handed
 * straight to `subtle.verify`.
 */
export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> | null {
  // Padding is not part of base64url but real-world producers sometimes emit it.
  let body = input
  while (body.endsWith('=')) body = body.slice(0, -1)
  // A single trailing character cannot encode a whole byte.
  if (body.length % 4 === 1) return null

  const out = new Uint8Array(Math.floor((body.length * 3) / 4))
  let acc = 0
  let bits = 0
  let n = 0
  for (let i = 0; i < body.length; i++) {
    const value = REVERSE.get(body[i])
    if (value === undefined) return null
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  // Leftover bits of a well-formed encoding are zero padding.
  if ((acc & ((1 << bits) - 1)) !== 0) return null
  // The allocation above is exact for every valid length, so a short write means
  // the input was not valid base64url after all.
  if (n !== out.length) return null
  return out
}

/** Decode base64url to a UTF-8 string, or null if either step fails. */
export function base64UrlToString(input: string): string | null {
  const bytes = base64UrlToBytes(input)
  if (bytes === null) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

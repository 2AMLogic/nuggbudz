/**
 * The slice of Stripe this app needs, spoken directly over the REST API.
 *
 * Deliberately not the `stripe` npm package: on Workers that SDK has to be
 * hand-wired onto a fetch HTTP client and a SubtleCrypto provider anyway, it
 * drags a large bundle into an isolate that only creates PaymentIntents and
 * refunds, and the browser half of Stripe cannot be bundled at all (Stripe.js
 * must be loaded from js.stripe.com). Three calls against a documented HTTP API
 * is less code than the adapter would be, and it leaves `fetch` injectable so
 * the whole module tests without touching the network.
 */

/** Stripe's live API root. Overridable so tests never resolve a real host. */
export const STRIPE_API_BASE = 'https://api.stripe.com/v1'

/** Stripe rejects webhook signatures older than this by default. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300

export interface StripeClientConfig {
  secretKey: string
  /** Injected in tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch
  apiBase?: string
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'StripeError'
  }
}

export interface CreatePaymentIntentInput {
  amountCents: number
  currency: string
  description: string
  /** Replays of the same logical charge must resolve to the same intent. */
  idempotencyKey: string
  metadata: Record<string, string>
}

export interface CreatedPaymentIntent {
  id: string
  /** Handed to the browser so Stripe.js can confirm the card. */
  clientSecret: string
}

/**
 * Encode a Stripe form body. Stripe takes nested values as `a[b]=c`, and this
 * app only ever nests one level deep (metadata), so that is all this handles.
 */
export function encodeStripeForm(
  params: Record<string, string | number | Record<string, string>>,
): string {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'object') {
      for (const [inner, innerValue] of Object.entries(value)) {
        out.set(`${key}[${inner}]`, innerValue)
      }
      continue
    }
    out.set(key, String(value))
  }
  return out.toString()
}

async function post(
  config: StripeClientConfig,
  path: string,
  body: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const doFetch = config.fetchImpl ?? fetch
  const response = await doFetch(`${config.apiBase ?? STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
      'Stripe-Version': '2025-08-27.basil',
    },
    body,
  })

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>
    throw new StripeError(
      typeof error.message === 'string' ? error.message : `stripe ${path} failed`,
      response.status,
      typeof error.code === 'string' ? error.code : undefined,
    )
  }
  return payload
}

export async function createPaymentIntent(
  config: StripeClientConfig,
  input: CreatePaymentIntentInput,
): Promise<CreatedPaymentIntent> {
  const payload = await post(
    config,
    '/payment_intents',
    encodeStripeForm({
      amount: input.amountCents,
      currency: input.currency,
      description: input.description,
      'automatic_payment_methods[enabled]': 'true',
      metadata: input.metadata,
    }),
    input.idempotencyKey,
  )

  const { id, client_secret: clientSecret } = payload
  if (typeof id !== 'string' || typeof clientSecret !== 'string') {
    throw new StripeError('stripe returned a PaymentIntent without an id or client secret', 502)
  }
  return { id, clientSecret }
}

/**
 * Refund a charge in full. Used when the other half of a match never paid —
 * there is no box, so there is nothing to keep.
 */
export async function refundPaymentIntent(
  config: StripeClientConfig,
  input: { paymentIntentId: string; idempotencyKey: string },
): Promise<{ id: string }> {
  const payload = await post(
    config,
    '/refunds',
    encodeStripeForm({ payment_intent: input.paymentIntentId }),
    input.idempotencyKey,
  )
  const { id } = payload
  if (typeof id !== 'string') throw new StripeError('stripe returned a refund without an id', 502)
  return { id }
}

/** The only two webhook events this app acts on. */
export type StripePaymentEventType = 'payment_intent.succeeded' | 'payment_intent.payment_failed'

export interface StripePaymentEvent {
  eventId: string
  type: StripePaymentEventType
  paymentIntentId: string
  amountCents: number
  metadata: Record<string, string>
}

export type SignatureFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'

export type VerifiedEvent = { ok: true; payload: unknown } | { ok: false; reason: SignatureFailure }

interface ParsedSignatureHeader {
  timestamp: number
  signatures: string[]
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (value === undefined) continue
    if (key === 't') {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed)) timestamp = parsed
    } else if (key === 'v1') {
      signatures.push(value)
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Compare without leaking where two digests diverge. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify a `Stripe-Signature` header over the raw request body.
 *
 * Two separate guards: the HMAC proves the body came from Stripe, and the
 * timestamp tolerance bounds how long a captured-and-replayed delivery stays
 * usable. Both are required — an attacker replaying yesterday's valid
 * `payment_intent.succeeded` still carries a valid signature.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  options: { toleranceSeconds?: number; nowMs?: number } = {},
): Promise<VerifiedEvent> {
  if (signatureHeader === null || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing_signature' }
  }
  const parsed = parseSignatureHeader(signatureHeader)
  if (parsed === null) return { ok: false, reason: 'malformed_signature' }

  const tolerance = options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000)
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${parsed.timestamp}.${rawBody}`),
    ),
  )
  if (!parsed.signatures.some((candidate) => constantTimeEquals(candidate, digest))) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  try {
    return { ok: true, payload: JSON.parse(rawBody) }
  } catch {
    return { ok: false, reason: 'malformed_signature' }
  }
}

/**
 * Narrow a verified webhook payload to the one shape this app acts on.
 *
 * Returns null for every other event type, which is not an error: Stripe
 * delivers whatever the endpoint is subscribed to, and an unrecognised event
 * is acknowledged and dropped rather than retried forever.
 */
export function parsePaymentEvent(payload: unknown): StripePaymentEvent | null {
  if (typeof payload !== 'object' || payload === null) return null
  const event = payload as Record<string, unknown>
  const type = event.type
  if (type !== 'payment_intent.succeeded' && type !== 'payment_intent.payment_failed') return null
  if (typeof event.id !== 'string') return null

  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const intent = (data as Record<string, unknown>).object
  if (typeof intent !== 'object' || intent === null) return null

  const { id, amount, metadata } = intent as Record<string, unknown>
  if (typeof id !== 'string') return null

  const flat: Record<string, string> = {}
  if (typeof metadata === 'object' && metadata !== null) {
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
      if (typeof value === 'string') flat[key] = value
    }
  }

  return {
    eventId: event.id,
    type,
    paymentIntentId: id,
    amountCents: typeof amount === 'number' ? amount : 0,
    metadata: flat,
  }
}

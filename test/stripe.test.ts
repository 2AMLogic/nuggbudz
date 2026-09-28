import { describe, expect, it } from 'vitest'
import {
  createPaymentIntent,
  encodeStripeForm,
  parsePaymentEvent,
  refundPaymentIntent,
  type StripeClientConfig,
  StripeError,
  verifyStripeSignature,
} from '../worker/lib/stripe'

const SECRET = 'whsec_test_secret'

/** A fetch stand-in: no network, and the request is captured for assertions. */
function stubFetch(
  body: unknown,
  init: { status?: number } = {},
): { config: StripeClientConfig; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} })
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { config: { secretKey: 'sk_test_x', fetchImpl }, calls }
}

function header(init: RequestInit, name: string): string {
  return (init.headers as Record<string, string>)[name]
}

async function signed(payload: string, timestamp: number, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  )
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${timestamp},v1=${hex}`
}

describe('encodeStripeForm', () => {
  it('flattens metadata the way Stripe expects', () => {
    const encoded = encodeStripeForm({
      amount: 449,
      currency: 'usd',
      metadata: { match_id: 'm1', cell: '9q8yyk' },
    })
    expect(decodeURIComponent(encoded)).toBe(
      'amount=449&currency=usd&metadata[match_id]=m1&metadata[cell]=9q8yyk',
    )
  })
})

describe('createPaymentIntent', () => {
  it('sends the amount in cents and passes the idempotency key through', async () => {
    const { config, calls } = stubFetch({ id: 'pi_1', client_secret: 'pi_1_secret' })
    const result = await createPaymentIntent(config, {
      amountCents: 449,
      currency: 'usd',
      description: 'split',
      idempotencyKey: 'match-1:orderer',
      metadata: { match_id: 'match-1', role: 'orderer', deal_id: 'd', cell: '9q8yyk' },
    })

    expect(result).toEqual({ id: 'pi_1', clientSecret: 'pi_1_secret' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents')
    expect(header(calls[0].init, 'Idempotency-Key')).toBe('match-1:orderer')
    expect(header(calls[0].init, 'Authorization')).toBe('Bearer sk_test_x')

    const sent = new URLSearchParams(String(calls[0].init.body))
    expect(sent.get('amount')).toBe('449')
    expect(sent.get('currency')).toBe('usd')
    expect(sent.get('metadata[cell]')).toBe('9q8yyk')
    expect(sent.get('metadata[match_id]')).toBe('match-1')
  })

  it('surfaces a Stripe error rather than returning a half-built intent', async () => {
    const { config } = stubFetch(
      { error: { message: 'card declined', code: 'card_error' } },
      {
        status: 402,
      },
    )
    await expect(
      createPaymentIntent(config, {
        amountCents: 449,
        currency: 'usd',
        description: 'split',
        idempotencyKey: 'k',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(StripeError)
  })
})

describe('refundPaymentIntent', () => {
  it('refunds by intent id under a per-leg idempotency key', async () => {
    const { config, calls } = stubFetch({ id: 're_1' })
    await refundPaymentIntent(config, {
      paymentIntentId: 'pi_1',
      idempotencyKey: 'refund:match-1:orderer',
    })
    expect(calls[0].url).toBe('https://api.stripe.com/v1/refunds')
    expect(header(calls[0].init, 'Idempotency-Key')).toBe('refund:match-1:orderer')
    expect(new URLSearchParams(String(calls[0].init.body)).get('payment_intent')).toBe('pi_1')
  })
})

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' })
  const nowMs = 1_700_000_000_000
  const nowSeconds = Math.floor(nowMs / 1000)

  it('accepts a correctly signed, fresh delivery', async () => {
    const result = await verifyStripeSignature(body, await signed(body, nowSeconds), SECRET, {
      nowMs,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a verified event')
    expect((result.payload as { id: string }).id).toBe('evt_1')
  })

  it('rejects an unsigned delivery', async () => {
    expect(await verifyStripeSignature(body, null, SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'missing_signature',
    })
    expect(await verifyStripeSignature(body, '', SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'missing_signature',
    })
  })

  it('rejects a header with no timestamp or no v1 signature', async () => {
    expect(await verifyStripeSignature(body, 'v1=deadbeef', SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    })
    expect(await verifyStripeSignature(body, `t=${nowSeconds}`, SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    })
  })

  it('rejects a signature made with the wrong secret', async () => {
    const result = await verifyStripeSignature(
      body,
      await signed(body, nowSeconds, 'whsec_someone_else'),
      SECRET,
      { nowMs },
    )
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects a body altered after signing', async () => {
    const signature = await signed(body, nowSeconds)
    const tampered = JSON.stringify({ id: 'evt_1', type: 'payment_intent.payment_failed' })
    expect(await verifyStripeSignature(tampered, signature, SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('rejects a replay of a genuinely signed delivery once it is stale', async () => {
    // Captured an hour ago: the signature is still valid, the timestamp is not.
    const signature = await signed(body, nowSeconds - 3600)
    expect(await verifyStripeSignature(body, signature, SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    })
    // …and still accepted while it is inside the window.
    const fresh = await signed(body, nowSeconds - 60)
    expect((await verifyStripeSignature(body, fresh, SECRET, { nowMs })).ok).toBe(true)
  })

  it('rejects a timestamp too far in the future', async () => {
    const signature = await signed(body, nowSeconds + 3600)
    expect(await verifyStripeSignature(body, signature, SECRET, { nowMs })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    })
  })
})

describe('parsePaymentEvent', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_1',
        amount: 449,
        metadata: { match_id: 'm1', role: 'orderer', deal_id: 'd', cell: '9q8yyk' },
      },
    },
    ...over,
  })

  it('extracts the intent, amount and routing metadata', () => {
    expect(parsePaymentEvent(event())).toEqual({
      eventId: 'evt_1',
      type: 'payment_intent.succeeded',
      paymentIntentId: 'pi_1',
      amountCents: 449,
      metadata: { match_id: 'm1', role: 'orderer', deal_id: 'd', cell: '9q8yyk' },
    })
  })

  it('handles the failure event too', () => {
    const parsed = parsePaymentEvent(event({ type: 'payment_intent.payment_failed' }))
    expect(parsed?.type).toBe('payment_intent.payment_failed')
  })

  it('ignores event types this app does not act on', () => {
    expect(parsePaymentEvent(event({ type: 'charge.dispute.created' }))).toBeNull()
  })

  it('ignores a malformed payload rather than trusting a cast', () => {
    expect(parsePaymentEvent(null)).toBeNull()
    expect(parsePaymentEvent('payment_intent.succeeded')).toBeNull()
    expect(parsePaymentEvent(event({ data: {} }))).toBeNull()
    expect(parsePaymentEvent(event({ data: { object: { amount: 449 } } }))).toBeNull()
  })

  it('drops non-string metadata instead of propagating it', () => {
    const parsed = parsePaymentEvent(
      event({ data: { object: { id: 'pi_1', amount: 449, metadata: { cell: 12 } } } }),
    )
    expect(parsed?.metadata).toEqual({})
  })
})

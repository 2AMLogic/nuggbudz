#!/usr/bin/env node
/**
 * The three Stripe REST calls this app makes, answered locally.
 *
 * Not a mock in the unit-test sense — `test/stripe.test.ts` already covers the
 * request shaping with an injected `fetch`. This exists so the *charged* pairing
 * path can be driven through the real Worker and the real Durable Object without
 * a Stripe account: `pnpm test` never reaches the Durable Object, and a payment
 * gate that has only ever been exercised as a pure function is a payment gate
 * nobody has exercised.
 *
 * Point a dev server at it with `STRIPE_API_BASE` in `.dev.vars`. It is never
 * reachable from a deployed Worker, and `stripeConfigured` still demands both
 * secrets, so this cannot weaken a real deployment — see `worker/env.ts`.
 *
 * Usage:  node scripts/fake-stripe.mjs --port 5312
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = Number(portArg === -1 ? (process.env.FAKE_STRIPE_PORT ?? 5312) : args[portArg + 1])

/** Every request this stub answered, so a checker can assert what was charged. */
const recorded = { intents: [], refunds: [] }

let seq = 0

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

/** Stripe takes `metadata[key]=value`; flatten it back for the assertions. */
function parseForm(raw) {
  const params = new URLSearchParams(raw)
  const out = { metadata: {} }
  for (const [key, value] of params) {
    const nested = key.match(/^metadata\[(.+)\]$/)
    if (nested !== null) {
      out.metadata[nested[1]] = value
      continue
    }
    out[key] = value
  }
  return out
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (req.method === 'GET' && url.pathname === '/__recorded') return json(200, recorded)
  if (req.method === 'GET' && url.pathname === '/__health') return json(200, { ok: true })

  if (req.method !== 'POST') return json(404, { error: { message: 'not found' } })

  const form = parseForm(await readBody(req))
  // Idempotency is the property being relied on in production, so honour it here
  // rather than minting a second object for a replayed key.
  const key = req.headers['idempotency-key'] ?? ''

  if (url.pathname === '/v1/payment_intents') {
    const existing = recorded.intents.find((intent) => intent.idempotencyKey === key)
    if (existing !== undefined) return json(200, existing.response)
    seq += 1
    const id = `pi_fake_${seq}`
    const response = { id, client_secret: `${id}_secret_fake`, status: 'requires_payment_method' }
    recorded.intents.push({
      idempotencyKey: key,
      amount: Number(form.amount),
      currency: form.currency,
      description: form.description,
      metadata: form.metadata,
      response,
    })
    return json(200, response)
  }

  if (url.pathname === '/v1/refunds') {
    const existing = recorded.refunds.find((refund) => refund.idempotencyKey === key)
    if (existing !== undefined) return json(200, existing.response)
    seq += 1
    const response = { id: `re_fake_${seq}`, payment_intent: form.payment_intent }
    recorded.refunds.push({
      idempotencyKey: key,
      paymentIntent: form.payment_intent,
      response,
    })
    return json(200, response)
  }

  return json(404, { error: { message: `no such fake stripe route: ${url.pathname}` } })
})

server.listen(PORT, () => {
  console.log(`fake stripe listening on http://localhost:${PORT}/v1`)
})

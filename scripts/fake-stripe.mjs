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
 * Usable two ways, because a backgrounded `&` step in CI does not reliably
 * outlive the step that started it — it did not: the `payment-gate-live` job
 * watched this print its banner and then die before the next step ran. So
 * `scripts/payment-gate-check.mjs` imports `startFakeStripe` and hosts it inside
 * its own process, where its lifetime is not a CI shell's to decide.
 *
 *   node scripts/fake-stripe.mjs --port 5312           # standalone, for local dev
 *   import { startFakeStripe } from './fake-stripe.mjs' # hosted, for the checker
 *
 * Two control routes, neither of which Stripe has:
 *
 *   GET  /__recorded            everything it has been asked for
 *   POST /__fail {"refunds":500}  answer /v1/refunds with that status until cleared
 *
 * The second one exists because "the refund call failed" is a state the app has
 * to report honestly and cannot be driven to from the outside otherwise. A
 * refund that is *attempted* and refused is still recorded, under
 * `refundAttempts` — asserting the attempt is how a caller tells "Stripe said no"
 * apart from "we never asked".
 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stripe takes nested values as `a[b]=c`; flatten metadata back for assertions. */
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

function readBody(req) {
  return new Promise((accept, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => accept(raw))
    req.on('error', reject)
  })
}

/**
 * Start the stub. Resolves once it is listening, with the record of everything it
 * has been asked for — which is what lets a caller assert the *amounts* that
 * reached Stripe rather than only the effects they had.
 */
export function startFakeStripe({ port }) {
  // `refunds` is refunds that SUCCEEDED; `refundAttempts` is every call, refused
  // or not. A caller asserting a buyer was made whole has to read the first.
  const recorded = { intents: [], refunds: [], refundAttempts: [] }
  const failures = { refunds: 0 }
  let seq = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (req.method === 'GET' && url.pathname === '/__recorded') return json(200, recorded)
    if (req.method === 'GET' && url.pathname === '/__health') return json(200, { ok: true })
    if (req.method !== 'POST') return json(404, { error: { message: 'not found' } })

    if (url.pathname === '/__fail') {
      const body = await readBody(req)
      const wanted = body.length === 0 ? {} : JSON.parse(body)
      failures.refunds = Number(wanted.refunds ?? 0)
      return json(200, { ...failures })
    }

    const form = parseForm(await readBody(req))
    // Idempotency is the property production relies on, so honour it here rather
    // than minting a second object for a replayed key.
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
      // Recorded before the outcome is decided, so a refused refund is
      // distinguishable from one that was never asked for.
      recorded.refundAttempts.push({ idempotencyKey: key, paymentIntent: form.payment_intent })
      if (failures.refunds > 0) {
        return json(failures.refunds, {
          error: { message: 'fake stripe was told to refuse refunds', code: 'refund_refused' },
        })
      }
      const existing = recorded.refunds.find((refund) => refund.idempotencyKey === key)
      if (existing !== undefined) return json(200, existing.response)
      seq += 1
      const response = { id: `re_fake_${seq}`, payment_intent: form.payment_intent }
      recorded.refunds.push({ idempotencyKey: key, paymentIntent: form.payment_intent, response })
      return json(200, response)
    }

    return json(404, { error: { message: `no such fake stripe route: ${url.pathname}` } })
  })

  return new Promise((accept) => {
    server.listen(port, () => accept({ server, recorded, failures }))
  })
}

// Standalone entry point, only when this file is the one node was handed.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const flag = args.indexOf('--port')
  const port = Number(flag === -1 ? (process.env.FAKE_STRIPE_PORT ?? 5312) : args[flag + 1])
  await startFakeStripe({ port })
  console.log(`fake stripe listening on http://localhost:${port}/v1`)
}

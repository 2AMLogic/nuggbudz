# NuggBudz

**Make friends. Eat nuggets. Save money.**

A hyper-local pairing protocol for splitting bulk fast food. Two people standing
near each other split one 20-piece box, and both pay less than either would
alone.

## The spread this arbitrages

Fast food bulk pricing is inverted: a 20-piece box costs *less* than two
10-piece boxes, and in some markets less than one. Anyone buying the small box is
paying a single-person tax.

| | Retail | Per nugget |
| :--- | ---: | ---: |
| 10pc box, solo | $6.99 | $0.70 |
| 10pc box, twice | $13.98 | $0.70 |
| **20pc box, split** | **$7.99** | **$0.40** |

Splitting a $7.99 box two ways with a $0.99 pairing fee means each buyer pays
**$4.49** — a **$2.50 (36%) saving each** — while the platform clears $0.99 on
$8.98 collected. The gross retail spread is $5.99 per pairing.

## How it works

1. Pick a deal and share your location once.
2. You join the pool for your **cell** — a geohash precision-6 box, roughly
   1.2km × 0.6km.
3. The moment another buyer within walking distance wants the same box, you are
   paired. The buyer who waited longest places the order; the other walks over.
4. Both see the same itemised settlement, down to the cent, and both pay their
   half.
5. The pickup code prints only once **both** halves have cleared. If one card
   declines, the other buyer is refunded and both go back in the queue — a
   half-paid match never produces a code.

## Architecture

```
Browser (React 19, Tailwind 4)          Stripe
   │  GET /api/deals                       ▲  confirm card (Stripe.js)
   │  WS  /api/pool/ws       live pairing  │
   ▼                                       │  POST /api/stripe/webhook
Cloudflare Worker (Hono)  ── derives the geohash cell server-side
   │                         verifies the webhook signature, then routes the
   │                         event by the `cell` on the PaymentIntent
   ▼
Durable Object: NuggPool  ── ONE PER CELL = one matching market
   │                          single-threaded, so double-pairing is impossible
   ▼
D1  ── ledger of settled splits
```

Payment results never come back over the buyer's socket — a client that claims
it paid is a client saying whatever it likes. They arrive as a signed Stripe
webhook, which the stateless Worker routes to the one NuggPool instance holding
the match by reading the `cell` stamped into the PaymentIntent metadata.

The matching rule, settlement math and geo helpers live in `shared/` and are
runtime-free, so they are unit-testable without a Workers runtime. See
[CLAUDE.md](./CLAUDE.md) for the invariants that matter.

## Getting started

```bash
pnpm install
pnpm dev              # Vite + Worker together on :5173
```

Two browser windows (or two phones on the same wifi) joining with nearby
coordinates will pair with each other live. If the browser refuses geolocation,
the app falls back to a fixed demo cell and says so.

```bash
pnpm test             # pure logic: settlement, geo, matchmaking, protocol
pnpm dev --port 5199  # in one shell…
pnpm smoke            # …then end-to-end pairing in another
pnpm typecheck
pnpm lint
```

## Stripe runbook

Three keys, and they are not interchangeable — two are Worker secrets that must
never reach the browser, one is a publishable key that must.

```bash
# 1 + 2. Worker secrets. Never in wrangler.jsonc, never in .env, never printed.
wrangler secret put STRIPE_SECRET_KEY        # sk_test_… from the Stripe dashboard
wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_… from the webhook endpoint

# 3. Publishable key, baked into the client bundle at build time.
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_… pnpm run deploy
```

Point a Stripe webhook endpoint at
`https://<your-worker>/api/stripe/webhook` and subscribe it to
`payment_intent.succeeded` and `payment_intent.payment_failed` — nothing else is
acted on. `STRIPE_WEBHOOK_SECRET` is that endpoint's signing secret, not the API
key: an unsigned, mis-signed or stale delivery is rejected with a 400.

Locally, `stripe listen --forward-to localhost:5199/api/stripe/webhook` prints a
`whsec_…` of its own; put it in `.dev.vars` (gitignored) alongside
`STRIPE_SECRET_KEY` to exercise the flow against `pnpm dev`.

**With no Stripe secrets bound, matches clear without being charged.** That is
what lets `pnpm dev` and `pnpm smoke` pair two buyers on a laptop with no Stripe
account. A deployment missing its secrets is a misconfiguration, so check
`wrangler secret list` after deploying to a new environment.

Test mode only for now: payouts to merchants, Connect accounts and live-mode
keys are not wired up.

## Deploy

Live: **https://nuggbudz.personal-account-251.workers.dev**

```bash
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_… pnpm run deploy   # `pnpm deploy` is a pnpm builtin
wrangler d1 migrations apply nuggbudz --remote
```

D1 and KV bindings are already provisioned in `wrangler.jsonc`. `/api/*` is
pinned to `run_worker_first`, because otherwise the SPA fallback answers the API
with `index.html` in production while `vite dev` works fine.

Verify a deployment end to end:

```bash
BASE=https://nuggbudz.personal-account-251.workers.dev pnpm smoke
```

## Roadmap

Current milestone: **M0 — live pairing.** Done: the matching engine, settlement
math, cell routing, and a working two-phone pairing flow.

Stripe settlement is in: both halves are charged on match, the $0.99 pairing fee
is only retained when both clear, and a one-sided failure refunds and requeues.

Next up, tracked as issues: Google OAuth, the D1 ledger write on pickup, payouts
to merchants (Connect) and live-mode keys, a map view of your cell, the pickup
confirmation handshake, and buddy reputation.

## Development

This project is developed with [Loom](https://github.com/rjwalters/loom). To run
the full Curator → Builder → Judge → Doctor → Merge lifecycle on a ready issue:

```bash
/loom:sweep <issue>
```

## License

MIT

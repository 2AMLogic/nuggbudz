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
4. Both see the same itemised settlement, down to the cent, and a pickup code.

## Architecture

```
Browser (React 19, Tailwind 4)
   │  GET /api/deals            catalogue + settlement + spread
   │  WS  /api/pool/ws          live pairing
   ▼
Cloudflare Worker (Hono)  ── derives the geohash cell server-side
   ▼
Durable Object: NuggPool  ── ONE PER CELL = one matching market
   │                          single-threaded, so double-pairing is impossible
   ▼
D1  ── ledger of settled splits
```

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

## Deploy

Live: **https://nuggbudz.personal-account-251.workers.dev**

```bash
pnpm run deploy                                   # `pnpm deploy` is a pnpm builtin
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

Next up, tracked as issues: Google OAuth, Stripe settlement with the pairing fee
taken as an application fee, the D1 ledger write on pickup, a map view of your
cell, the pickup confirmation handshake, and buddy reputation.

## Development

This project is developed with [Loom](https://github.com/rjwalters/loom). To run
the full Curator → Builder → Judge → Doctor → Merge lifecycle on a ready issue:

```bash
/loom:sweep <issue>
```

## License

MIT

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

1. Sign in with Google, pick a deal and share your location once.
2. You join the pool for your **cell** — a geohash precision-6 box, roughly
   1.2km × 0.6km.
3. The moment another buyer within walking distance wants the same box, you are
   paired. The buyer who waited longest places the order; the other walks over.
4. Both see the same itemised settlement, down to the cent, and a pickup code.

A seat in the pool is not forever. A buyer who goes quiet for 15 minutes is
warned and then dropped, and a match nobody confirms within 10 minutes is called
off and both halves told — otherwise you get paired with somebody who left ten
minutes ago. Both windows are Worker vars (`QUEUE_IDLE_SECONDS`,
`QUEUE_WARN_LEAD_SECONDS`, `MATCH_CONFIRM_SECONDS` in `wrangler.jsonc`), and the
client pings to hold its place while you wait.

## Architecture

```
Browser (React 19, Tailwind 4)
   │  GET /api/auth/google/*    sign-in, PKCE, terminating in the Worker
   │  GET /api/deals            catalogue + settlement + spread
   │  WS  /api/pool/ws          live pairing — requires a session
   ▼
Cloudflare Worker (Hono)  ── derives the geohash cell server-side,
   │                          and the buyer's identity from their session
   ├─▶ KV: SESSIONS      ── opaque session ids, pending PKCE state, Google JWKS
   ├─▶ D1: users         ── one row per Google account
   ▼
Durable Object: NuggPool  ── ONE PER CELL = one matching market
   │                          single-threaded, so double-pairing is impossible
   ▼
D1  ── ledger of settled splits
```

Sign-in is Authorization Code + PKCE and never leaves a token in the browser:
the Worker verifies the ID token's signature against Google's JWKS, checks `aud`
and `iss`, upserts the user on `google_sub` and hands back an opaque session id
in an `HttpOnly; Secure; SameSite=Lax` cookie. The pool socket derives the
display name a buddy sees from that session, so a client cannot present itself
as somebody else.

The matching rule, settlement math and geo helpers live in `shared/` and are
runtime-free, so they are unit-testable without a Workers runtime. See
[CLAUDE.md](./CLAUDE.md) for the invariants that matter.

## Getting started

```bash
pnpm install
cp .dev.vars.example .dev.vars    # then fill in your Google OAuth client
pnpm dev                          # Vite + Worker together on :5173
```

Google sign-in needs a "Web application" OAuth client (Google Cloud Console →
APIs & Services → Credentials) with `http://localhost:5173/api/auth/google/callback`
as an authorized redirect URI. Without one the app still boots and the auth
routes answer `503`; `pnpm test` and `pnpm smoke` do not need it. `.dev.vars` is
gitignored and `GOOGLE_CLIENT_SECRET` never belongs in `wrangler.jsonc`.

Two browser windows (or two phones on the same wifi) joining with nearby
coordinates will pair with each other live. If the browser refuses geolocation,
the app falls back to a fixed demo cell and says so.

```bash
pnpm test             # pure logic: settlement, geo, matchmaking, auth, protocol
pnpm dev --port 5199  # in one shell…
pnpm smoke            # …then end-to-end pairing in another
pnpm typecheck
pnpm lint
```

## Deploy

Live: **https://nuggbudz.personal-account-251.workers.dev**

```bash
wrangler secret put GOOGLE_CLIENT_ID              # once per environment
wrangler secret put GOOGLE_CLIENT_SECRET
pnpm run deploy                                   # `pnpm deploy` is a pnpm builtin
wrangler d1 migrations apply nuggbudz --remote
```

D1 and KV bindings are already provisioned in `wrangler.jsonc`. `/api/*` is
pinned to `run_worker_first`, because otherwise the SPA fallback answers the API
with `index.html` in production while `vite dev` works fine.

`pnpm smoke` seeds its own sessions into the **local** KV namespace, because the
pool socket now requires one and an OAuth round trip cannot be driven
unattended. It therefore runs against `pnpm dev`, not against a deployment; the
REST surface of a deployment can still be checked with
`curl https://nuggbudz.personal-account-251.workers.dev/api/health`.

## Pitch deck

`docs/pitch/` holds the hackathon deck, built with [Anvil](https://github.com/rjwalters/anvil).
The slides are `docs/pitch/nuggbudz-hackathon/nuggbudz-hackathon.2/deck.pdf`; the
talk track and the demo fallback script are in `speaker-notes.md` beside it.

Every money figure on a slide is derived from `shared/deals.ts` and
`shared/economics.ts` by `scripts/deck-ledger.ts`, and `pnpm test` fails if a
slide and the code disagree in either direction. See
[docs/pitch/README.md](./docs/pitch/README.md).

## Roadmap

Current milestone: **M0 — live pairing.** Done: the matching engine, settlement
math, cell routing, a working two-phone pairing flow, and Google sign-in.

Next up, tracked as issues: Stripe settlement with the pairing fee taken as an
application fee, the D1 ledger write on pickup, a map view of your cell, the
pickup confirmation handshake, and buddy reputation.

## Development

This project is developed with [Loom](https://github.com/rjwalters/loom). To run
the full Curator → Builder → Judge → Doctor → Merge lifecycle on a ready issue:

```bash
/loom:sweep <issue>
```

## License

MIT

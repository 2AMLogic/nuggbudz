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

Live: **https://nuggbudz.com** (also `www.nuggbudz.com`, and the
`*.workers.dev` name). Both custom domains are declared as `routes` in
`wrangler.jsonc`, so Wrangler provisions the DNS records and the certificate on
deploy — the zone has to be on the same Cloudflare account as the Worker.

```bash
wrangler secret put GOOGLE_CLIENT_ID              # once per environment
wrangler secret put GOOGLE_CLIENT_SECRET
pnpm run deploy                                   # `pnpm deploy` is a pnpm builtin
wrangler d1 migrations apply nuggbudz --remote
```

### Demo pairing

Pairing requires a signed-in account. That is right for production and fatal on
a stage: without the two secrets above, sign-in answers 503 and the pool socket
answers 401, so **nobody can pair at all**. The escape hatch is a deploy-time
var:

```bash
pnpm exec vite build && wrangler deploy --var ALLOW_DEMO_PAIRING:1
```

With it set, an unauthenticated socket is given a throwaway `demo:<uuid>`
identity and pairs under a name the caller types; the UI says on screen that it
is pairing without accounts. The caller may propose a *display name* but never a
user id — the id is minted server-side, so two tabs cannot claim one identity.

**It is deliberately absent from `wrangler.jsonc`.** Passing it only at deploy
time means a checkout, `pnpm test`, `pnpm smoke` and CI all keep exercising the
strict authenticated path, and no `vite build` can bake an auth bypass into a
production artifact. Verify whichever mode a server is in:

```bash
BASE=http://localhost:5199 node scripts/demo-pairing-check.mjs
```

It reads `/api/health` and asserts the matching half: flag off ⇒ an
unauthenticated upgrade is refused 401; flag on ⇒ two unauthenticated clients
pair with each other, with `demo:` identities and the same $4.49 split.

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

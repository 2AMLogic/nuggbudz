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

1. Sign in with Google and pick a deal. There is no location prompt: the Worker
   places you from Cloudflare's edge geo (`request.cf`), which is accurate to
   about a neighbourhood — exactly what a cell needs. "Use my exact location" is
   a separate control, and the only thing that ever asks permission.
2. You join the pool for your **cell** — a geohash precision-6 box, roughly
   1.2km × 0.6km.
3. The moment another buyer within walking distance wants the same box, you are
   paired. The buyer who waited longest places the order; the other walks over.
4. Both see the same itemised settlement, down to the cent, and are charged
   their own half. `$0.99` of the total is the pairing fee, and it is retained
   only when **both** halves clear — a half-collected match is a loss to be
   refunded, not a fee to book.
5. Once both cards clear, the orderer's receipt prints a pickup code. The
   receiver reads it off them at the handoff and types it in; the orderer taps
   to agree. Only that two-sided confirmation writes a row to the ledger.

**A disputed split holds the money.** If one buddy confirms the handoff and the
other never does, nothing is booked to the ledger and **nothing is refunded
automatically** — the $8.98 is held against the server's record until a human
reconciles it. That is deliberate: auto-refunding a dispute would make staying
silent after collecting the box the cheapest way to eat for free, which is the
same reasoning that writes no ledger row. A match that dies for any *other*
reason — a declined card, a cancellation, a buddy who left before anybody
confirmed — is refunded, and the screen states what came back and what (if
Stripe refused the refund) is still being held for a human.

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
Cloudflare Worker (Hono)  ── derives the geohash cell server-side (edge geo,
   │                          no prompt) and the buyer's identity from their session
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

Two browser windows (or two phones on the same wifi) will pair with each other
live, with location permission denied on both — the cell comes from the server.
Location resolves in three rungs, most precise first (`shared/location.ts`):

| Rung | Source | Prompts? |
|------|--------|----------|
| 1 | coordinates from the client | only if the buyer tapped "use my exact location" |
| 2 | `request.cf.latitude` / `.longitude` at the edge | no |
| 3 | a fixed demo origin | no |

Rung 2 works locally too: miniflare fetches a real `cf` and caches it in
`node_modules/.mf/cf.json`, so `pnpm dev` places you in your own city. Strip the
coordinates out of that file (or run with no network) and every socket drops to
rung 3 instead of failing — `pnpm smoke` passes either way. The screen always
says which rung placed you, and only rung 1 is ever described as exact.

Pairing also needs a way to charge, or an explicit statement that this server
does not — see [Payments](#payments-and-what-happens-without-them). For local
pairing, put `ALLOW_UNCHARGED_PAIRING="1"` in `.dev.vars`; without it (and
without Stripe secrets) a join is refused with `payment_unavailable` rather than
quietly pairing for free.

```bash
pnpm test             # pure logic: settlement, geo, matchmaking, auth, protocol
pnpm dev --port 5199  # in one shell…
pnpm smoke            # …then end-to-end pairing in another
pnpm payment-gate     # …and the money gate, in whichever mode that server is in
pnpm typecheck
pnpm lint
```

## Deploy

Live: **https://nuggbudz.com** (also `www.nuggbudz.com`, and the
`*.workers.dev` name). Both custom domains are attached to the Worker outside
this repo: `wrangler.jsonc` carries no `routes` block, so `pnpm run deploy`
publishes the Worker but does not provision the DNS records or the certificate.
The zone has to be on the same Cloudflare account as the Worker.

```bash
wrangler secret put GOOGLE_CLIENT_ID              # once per environment
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put STRIPE_SECRET_KEY              # payments; see below
wrangler secret put STRIPE_WEBHOOK_SECRET
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_… pnpm run deploy   # sign-in only — see "Demo pairing"
wrangler d1 migrations apply nuggbudz --remote
```

### Payments, and what happens without them

Three keys, two of them secret:

| Key | Where it lives | Why |
|-----|----------------|-----|
| `STRIPE_SECRET_KEY` | `wrangler secret put` | Creates the two PaymentIntents and issues refunds. |
| `STRIPE_WEBHOOK_SECRET` | `wrangler secret put` | Verifies that a payment result really came from Stripe. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | build-time env | Baked into the bundle for Stripe.js. Public by design. |

Point a Stripe webhook endpoint at `POST /api/stripe/webhook`, subscribed to
`payment_intent.succeeded` and `payment_intent.payment_failed`. The buyer's
browser never tells the server it paid — the server believes the signed webhook
and nothing else.

**A pool with either secret missing refuses to pair.** Not "pairs without
charging": a buyer who joins is told `payment_unavailable` and never takes a
seat. This is deliberate and it is the whole safety property — a single forgotten
`wrangler secret put` on a live URL would otherwise hand two strangers a working
pickup code for a box nobody paid for, silently, until somebody noticed. Check a
deploy in one call:

```bash
curl -s https://nuggbudz.com/api/health     # { "payments": "live" | "uncharged" | "unconfigured" }
```

`unconfigured` on a public URL means pairing is broken, not free. `live` is the
only mode that takes money. Both deploy scripts print this back off the deployed
Worker's own `/api/health` when they finish — see `scripts/post-deploy-mode.mjs`
— so an unset secret announces itself rather than waiting to be noticed.

Local development and the two test lanes that drive pairing end to end need a
zero-money path, and it is an **explicit opt-in**, checked *in addition to* the
secrets being absent rather than instead of them:

```
ALLOW_UNCHARGED_PAIRING="1"      # .dev.vars only, never wrangler.jsonc
```

That conjunction is the point: an empty production secret can never be mistaken
for intentional test mode, because intentional test mode has to say so. With
Stripe configured this var does nothing at all — it cannot switch a working
payment path off.

To exercise the *charged* path with no Stripe account, `scripts/fake-stripe.mjs`
answers the three REST calls this app makes:

```bash
cat > .dev.vars <<'VARS'
STRIPE_SECRET_KEY="sk_test_fake"
STRIPE_WEBHOOK_SECRET="whsec_fake"
STRIPE_API_BASE="http://127.0.0.1:5312/v1"
VARS
pnpm dev --port 5248              # in one shell
# FAKE_STRIPE_SERVE makes the checker host the stub itself, so there is no third
# process to keep alive. `pnpm fake-stripe -- --port 5312` runs it standalone if
# you want to poke at it by hand.
BASE=http://localhost:5248 FAKE_STRIPE=http://localhost:5312 FAKE_STRIPE_SERVE=5312 \
  STRIPE_WEBHOOK_SECRET=whsec_fake pnpm payment-gate
```

`pnpm payment-gate` reads `/api/health` and asserts whichever of the three modes
the server is actually in — including that an `unconfigured` one pairs nobody and
releases no code. CI runs it in all three (`smoke`, `payment-gate-closed`,
`payment-gate-live`).

A **demo pairing never reaches Stripe**, on any deploy, configured or not:
`paymentDisposition` answers `demo` before it looks at the secrets, for the same
reason `worker/ledger.ts` refuses to book a demo split as revenue. The
`demo-check` CI job proves it by contradiction — it runs with Stripe
"configured" against an API base nothing is listening on, so a demo pair that
tried to charge would fail the job rather than quietly succeed.

### Demo pairing

Pairing requires a signed-in account. That is right for production and fatal on
a stage: without the two secrets above, sign-in answers 503 and the pool socket
answers 401, so **nobody can pair at all**. There are two deploy scripts, and
they leave production in two different modes — pick the one you mean:

```bash
pnpm run deploy         # strict: sign-in required, matches production
pnpm run deploy:demo    # stage: vite build && wrangler deploy --var ALLOW_DEMO_PAIRING:1
```

`pnpm run deploy` (plain) leaves the site **sign-in-only** — the same 401 for
every unauthenticated pool socket described above. It is not a "safe default
that also happens to allow demo pairing"; use `deploy:demo` when a stage needs
the escape hatch. Both scripts run the same `vite build && wrangler deploy`
underneath and then print the mode the deployment actually ended up in, read
back from the deployed Worker's own `/api/health` — never from which script you
ran — so a config drift or a stale cached build cannot pass silently.

With demo pairing on, an unauthenticated socket is given a throwaway
`demo:<uuid>` identity and pairs under a name the caller types; the UI says on
screen that it is pairing without accounts. The caller may propose a *display
name* but never a user id — the id is minted server-side, so two tabs cannot
claim one identity.

**`ALLOW_DEMO_PAIRING` is deliberately absent from `wrangler.jsonc`.** Passing
it only at deploy time means a checkout, `pnpm test`, `pnpm smoke` and CI all
keep exercising the strict authenticated path, and no `vite build` can bake an
auth bypass into a production artifact. Verify whichever mode a server is in:

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

Next up, tracked as issues: payouts to merchants through Stripe Connect, a
retry queue for a refund that fails at Stripe, and buddy reputation.

## Development

This project is developed with [Loom](https://github.com/rjwalters/loom). To run
the full Curator → Builder → Judge → Doctor → Merge lifecycle on a ready issue:

```bash
/loom:sweep <issue>
```

## License

MIT

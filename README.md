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
   about a neighbourhood. "Use my exact location" is a separate control, and the
   only thing that ever asks permission.
2. You join the pool, and the screen draws the market: a **2-mile circle** around
   wherever the server placed you, with a dot for everyone else already waiting
   inside it. The circle is the rule — `MATCH_RADIUS_METERS` — not a picture of
   one.
3. The moment another buyer inside that circle wants the same box, you are
   paired. The buyer who waited longest places the order; the other walks over.
4. Both see the same itemised settlement, down to the cent, and are charged
   their own half. `$0.99` of the total is the pairing fee, and it is retained
   only when **both** halves clear — a half-collected match is a loss to be
   refunded, not a fee to book.
5. Once both cards clear, the orderer's receipt prints a pickup code — as a
   scannable QR and as six characters. At the handoff the receiver either points
   a camera at it or reads it out and types it, and then the orderer taps to
   agree. The code is never sent to the receiver by the server, so every route
   is the same act: it travels the last few feet through the air, not over the
   network. **A scan fills the field; it does not confirm.** Only that two-sided
   confirmation writes a row to the ledger.

   The QR carries a **link** — `nuggbudz.com/h/K7M2QX` — rather than the bare
   code, so a phone's own camera app is enough and the receiver does not need
   this app's scanner. Opening that link hands the code to whoever opened it and
   nothing more: if that browser is the one holding the match it lands in the
   confirm field, and if it is not, the screen simply prints six characters to
   read out. It can never confirm by itself, because `confirm_pickup` still
   arrives on an authenticated socket and the server still checks that socket is
   the receiver of that match. That check — not the secrecy of a code anybody
   standing next to you could already read — is what protects the handoff.

**A disputed split holds the money.** If one buddy confirms the handoff and the
other never does, nothing is booked to the ledger and **nothing is refunded
automatically** — the $8.98 is held until a human reconciles it. That is
deliberate: auto-refunding a dispute would make staying silent after collecting
the box the cheapest way to eat for free, which is the same reasoning that writes
no ledger row. A match that dies for any *other* reason — a declined card, a
cancellation, a buddy who left before anybody confirmed — is refunded, and the
screen states what came back and what (if Stripe refused the refund) is still
being held for a human.

The dispute itself is filed in D1 — who confirmed, when, why the handshake died,
and how much is held — and an operator resolves it from there. See
[Disputes](#disputes-and-who-resolves-them). A refund Stripe *refuses* on one of
those other teardowns is filed too, in its own queue, with a retry: see
[Holds](#holds-and-money-stripe-would-not-give-back).

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
Cloudflare Worker (Hono)  ── derives the position server-side (edge geo, no
   │                          prompt) and the buyer's identity from their session
   ├─▶ KV: SESSIONS      ── opaque session ids, pending PKCE state, Google JWKS
   ├─▶ D1: users         ── one row per Google account
   ▼
Durable Object: NuggPool  ── ONE PER GEOHASH CELL = one shard, deliberately much
   │                          wider (~156 km) than the 2-mile market it contains,
   │                          so one single-threaded object sees every candidate
   │                          it might pair and double-pairing is impossible
   ▼
D1  ── ledger of settled splits, and the queue of disputed ones
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
live, with location permission denied on both — the position comes from the
server, and the map is drawn from it either way.
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

Add `POOL_UPGRADE_LIMIT="300"` there too before running `pnpm test:e2e`. The
socket limiter keys on `CF-Connecting-IP`, which `pnpm dev` never sets, so every
local client shares the `unknown` bucket and a suite that opens several dozen
sockets a minute trips a limit sized for a venue NAT. It surfaces as "Lost the
connection. Try again." rather than as a refusal you can read.

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

**Turning payments on is three steps, not two:** `wrangler secret put
STRIPE_SECRET_KEY`, `wrangler secret put STRIPE_WEBHOOK_SECRET`, **and a rebuild**
with `VITE_STRIPE_PUBLISHABLE_KEY` set, because that key is compiled into the
bundle and a secret cannot reach it. Secrets alone leave a deployment that
refuses to pair anyone who is not a demo buyer, and whose card form cannot mount
("This build has no Stripe publishable key"). The two `secret put` calls are
human steps; an agent cannot perform them.

`pnpm run deploy` stamps `dist/client/build-info.json` after the build (the key's
mode, `live`/`test`/`none`, found by scanning the emitted bundle, never the key
itself), and `scripts/post-deploy-mode.mjs` compares it to `/api/health`'s
`payments`. A deployment that is `payments: live` while the bundle carries no
publishable key exits non-zero.

**Open product decision (not resolved here): demo vs. charged pairing.** A strict
deploy is sign-in only, and demo pairs are never charged, so today going live with
charged pairing means unauthenticated pairing stops working the same day and the
demo everyone has been shown stops with it. Keeping production on `deploy:demo`
keeps the demo but means demo buyers are never charged. Which to run is the
operator's call. #150 (gate sign-in at `join` rather than at the socket) would
loosen this, since a signed-out visitor could still see the market on a charged
deployment; as of this writing #150 is **open**, so the current regime is the one
above.

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

### Disputes, and who resolves them

A dispute is the second most likely outcome of asking two strangers to meet, so
it is not an error path: it is a queue. The Durable Object files the dead
handshake into D1's `disputes` table — the reason (`timeout` or `buddy_left`),
which side confirmed and when, both buddies, and the integer cents being held —
and **deletes its own copy only once that write has landed**. A settled split is
booked to `matches` the same way. Neither terminal record stays in the cell.

`disputes` is a table of its own rather than a status column on `matches`,
because `matches` answers exactly one question — which splits settled — and every
revenue figure here is a `WHERE settled_at IS NOT NULL` over it. A dispute is not
a weaker split.

```bash
wrangler secret put OPERATOR_USER_IDS     # comma-separated users.id values
curl -s --cookie "nb_session=…" https://nuggbudz.com/api/admin/disputes
curl -s -X POST --cookie "nb_session=…" -H 'content-type: application/json' \
  -d '{"resolution":"refund_receiver","note":"orderer never showed"}' \
  https://nuggbudz.com/api/admin/disputes/<matchId>/resolve
```

Four resolutions, each named for what it does to the money, because that is the
only part of a decision that cannot be taken back:

| Resolution | Money outcome |
|---|---|
| `settled` | The handoff did happen; the silent buddy never tapped. Nothing is returned. |
| `voided` | It did not happen, or cannot be established. Both halves are refunded. |
| `refund_orderer` | The orderer turned up and the receiver did not. The orderer is made whole. |
| `refund_receiver` | The receiver turned up and the orderer did not. The receiver is made whole. |

The refund is issued against the charges the dead match left behind, and — like
every other refund here — the row records only what Stripe *confirmed*.
`refunded_cents` stays `NULL` until the call has been answered for at all, which
is not the same as `0`; on a server with no Stripe secrets it is `0`, meaning
"no charge was taken, nothing to refund".

**The decision is made once; its refund can be asked for again.** Overturning a
resolution is refused (`409 decided_differently`) and always was, enforced in SQL
(`WHERE resolved_at IS NULL`) rather than by a read-then-write. But a refund can
fail like any other — Stripe declines it, or the call never completes — and that
used to get the same `409`, which left money held with no way back through the one
route that exists to release it. So re-POSTing the **same** resolution retries the
refund: safe any number of times, because every refund is keyed
`refund:<matchId>:<role>` and a leg Stripe has already handed back is no longer
owed. `outstanding_cents` is what the resolution promised to return and has not,
as the Durable Object reported it — `NULL` or greater than zero is retryable, and
zero is a `409 refund_complete` because there is nothing left to do. A retry pays
out; it never rewrites `resolved_by`, `resolved_at`, `resolution` or the note.
Comparing `refunded_cents` against `held_cents` cannot answer this: `settled`
refunds nobody on purpose, and `refund_orderer` pays back one half of money that
is still holding the other.

**Authorization is a session plus an allowlist, not a shared token.**
`OPERATOR_USER_IDS` names `users.id` values; the caller still has to be signed in
as one of them, and the row records `resolved_by` as that account. A bearer token
could only ever record "whoever had the token", and could not be revoked without
a redeploy — a session is one KV delete. Entries that are not shaped like an id a
sign-in could mint (a wildcard, a `demo:` identity) are dropped rather than
honoured, and with the var unset **there are no operators**: every `/api/admin/*`
route answers the same `404` the rest of the API gives an unknown path, so a
signed-in buyer cannot even learn the surface is there. It is deliberately absent
from `wrangler.jsonc`, for the same reason `ALLOW_DEMO_PAIRING` is.

### Holds, and money Stripe would not give back

A dispute holds money on purpose. The other way money gets stuck is that a
teardown *asked* for the refund and Stripe refused it — a match nobody confirmed
in time, a pair that could not be charged, a buddy who closed the tab. Nobody
disputed anything, so by construction there is no human in the loop, and the
charges live on as a tombstone inside the one Durable Object that owned the
match. There is no registry of live cells to fan out to, so before `holds`
existed that money could not be enumerated at all.

So the same rule the disputes queue follows applies here: at the moment the
match record is deleted, and **before** it is deleted, a row goes into D1's
`holds` table — the teardown (`match_expired`, `payment_unavailable`,
`buddy_left`, `payment_failed`), both buddies, the cell that still holds the
charges, and the integer cents outstanding. A teardown whose refund Stripe
honoured writes nothing: it owes nobody anything, and an operator's queue that
lists it is a queue nobody reads.

```bash
curl -s --cookie "nb_session=…" https://nuggbudz.com/api/admin/holds
curl -s -X POST --cookie "nb_session=…" \
  https://nuggbudz.com/api/admin/holds/<matchId>/retry
```

There is nothing to *resolve* — nobody decided a hold — so the only action is to
ask again. That is safe any number of times because every refund is keyed on
`refund:<matchId>:<role>`, and a leg Stripe has already handed back is no longer
owed. What a retry recovers is stamped on the row only after Stripe answers, the
same discipline `disputes.refunded_cents` follows: `NULL` means no retry has
been answered for, which is not `0`. A hold that reaches zero is released and
drops out of the queue; retrying a released one is refused (`409`).

`holds` is a third table rather than more rows in `disputes`, because the two
are different questions. A dispute is a decision somebody owes an answer to; a
hold is a failure somebody owes a retry to.

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

With demo pairing on, an unauthenticated caller is given a throwaway `demo:`
identity and pairs under a name they type; the UI says on screen that it is
pairing without accounts. The caller may propose a *display name* but never a
user id — the id is minted server-side, on a cookie `/api/health` sets, and is
therefore **sticky per browser**.

**That stickiness costs the single-device demo, deliberately.** It has to exist:
a phone's camera app opens the handoff link in a new tab, a new tab is a new
socket, and an identity minted per socket would arrive at the handoff as a
stranger the match has never heard of. The price is that two tabs in one browser
are now one buyer — the self-match guard refuses to pair them, and says which
tab you are already in — so **demoing the pairing flow needs two devices.**

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

**`wrangler dev --var ALLOW_DEMO_PAIRING=on` is a different lever from the one
above, and it does not reliably work — don't reach for it.** On the currently
pinned wrangler version (confirmed on 4.142.0, macOS arm64), `wrangler dev
--var` lists the binding in its startup table but the Worker sees
`env.ALLOW_DEMO_PAIRING` as `undefined` at runtime (#37). It was never
load-bearing here anyway: local dev runs through `pnpm dev` (`vite dev`), not
`wrangler dev`, and CI's `demo-check` job already sets the flag through
`.dev.vars` for exactly this reason. `.dev.vars` (gitignored, read by `pnpm
dev`) is the only mechanism to trust locally. Whether `wrangler deploy --var`
— the mechanism `deploy:demo` actually uses against production — has the same
defect is **not yet confirmed either way**; verify it on the next real deploy
by reading `scripts/post-deploy-mode.mjs`'s banner (or `curl
<deploy-url>/api/health`) immediately after running `pnpm run deploy:demo`,
rather than assuming either outcome.

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
math, radius matching, a working two-phone pairing flow, and Google sign-in.

Next up, tracked as issues: payouts to merchants through Stripe Connect, an
automatic sweep over the holds queue rather than an operator-triggered retry,
and buddy reputation.

## Development

This project is developed with [Loom](https://github.com/rjwalters/loom). To run
the full Curator → Builder → Judge → Doctor → Merge lifecycle on a ready issue:

```bash
/loom:sweep <issue>
```

## License

MIT

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

`HONEYPOT_BUYERS="1"` in `.dev.vars` seats decoy buyers so a lone browser sees a
market rather than an empty circle — see
[Honeypot buyers](#honeypot-buyers) for what they can and, more importantly,
cannot do. It is off by default everywhere, including in every test lane, so a
suite that expects an empty market stays correct.

Add `POOL_ANON_UPGRADE_LIMIT="300"` there too before running `pnpm test:e2e`.
This is about the local server, not the production figure: the anonymous upgrade
window is counted per connecting address, the limiter reads that from
`CF-Connecting-IP`, and `pnpm dev` never sets it — so every signed-out local
client shares one `unknown` address, and a suite that opens a browse socket per
landing page trips a window sized for one venue NAT. The signed-in window needs
nothing: since #106 it is per buyer, not per address (see "The flood backstop"
under [Browsing before signing in](#browsing-before-signing-in)).

```bash
pnpm test             # pure logic: settlement, geo, matchmaking, auth, protocol
pnpm dev --port 5199  # in one shell…
pnpm smoke            # …then end-to-end pairing in another
pnpm payment-gate     # …and the money gate, in whichever mode that server is in
pnpm honeypot-check   # …and decoy buyers, in whichever mode that server is in
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
wrangler d1 migrations apply nuggbudz --remote      # before the deploy, not after
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_… pnpm run deploy   # sign-in only — see "Demo pairing"
```

### The schema the deployment is actually on

Applying migrations is still a human step — a deploy does not mutate the
production schema — but **forgetting it is no longer silent.** `pnpm run deploy`
and `pnpm run deploy:demo` both end by comparing this checkout's `migrations/`
against what the live database holds (`wrangler d1 migrations list nuggbudz
--remote`, wrapped by `scripts/migration-check.mjs`), and exit non-zero naming
every file the database is missing. `pnpm migration-check` asks the same question
on its own, `--local` against the local D1.

It exists because production sat **three migrations behind** this repo for an
unknown period with every check green (#135): `0002_users`, `0003_sauce_prefs`
and `0004_disputes` were unapplied, so sign-in, sauce preferences and dispute
persistence had no tables to write to, and nothing could have told you.
`/api/health` describes the Worker, not the database behind it; `pnpm demo-check`
passes against a missing table because a demo pair deliberately writes no rows;
and `pnpm test` / `pnpm smoke` run against a local D1 that was fully migrated.
The same blind spot `scripts/post-deploy-mode.mjs` closed one layer up for a
stale client bundle (#74) — a check that cannot fail for the thing it is named
after.

Two things about `wrangler d1 migrations list` decide the shape of that check:
it **exits 0 either way**, so the exit code carries no signal and a banner line
is the whole answer (there is no `--json`), and that clean banner is also what an
empty `migrations/` prints. So the verdict has three values, not two —
`COULD NOT DETERMINE` is reported distinctly from up-to-date and also exits
non-zero, because a check that could not run must not read like one that passed.
It is deliberately **not** in CI: a pull request has no production credentials,
so every run there would be undetermined, which is noise rather than a signal.

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

### Browsing before signing in

Taking a seat requires a signed-in account; **looking does not** (#150). The
pool socket is open to everybody: a signed-out visitor is welcomed under an
anonymous identity (the per-browser `nb_demo` cookie `/api/health` hands out),
placed like any other socket, and sent `market` frames — how many are waiting
within their radius, overall and per deal. That count is the product's whole
argument, and asking for a Google account before showing it asked people to sign
up to find out whether signing up was worth it.

The account is asked for at the one moment it is needed: when the visitor taps
"Find a bud". Whether an identity may take a seat is answered in exactly one
place, `seatVerdict` in `shared/identity.ts`, called from the Durable Object's
`join` path — never at the upgrade and never only in the client. An anonymous
`join` on a server that seats accounts only is refused on the wire with
`sign_in_required`, and the client turns that refusal into a sign-in
interstitial. The seat being taken — deal and sauces, not the precise
coordinates — is kept in `sessionStorage` across the Google round trip, and the
buyer is seated on return without choosing again.

Why the gate is the seat and not the socket, or anything later: money clears
before the handshake starts, so a buyer met by a sign-in wall *after* pairing
would abandon a match with their buddy's charge already in flight — and an
anonymous tail has no account for `standingBand` to hold a no-show against.
Why it has to be on the server: an anonymous identity is `demo:`, and
`paymentDisposition` answers `demo` for any pair containing one before Stripe is
consulted. An anonymous seat on a charged deployment would be a free pair.

What a socket without a seat is **not** sent: the `buddies` roster. The snapped,
nameless dots of who is waiting go only to a socket that took a seat, on
`waiting`; an idle socket, signed in or not, gets counts. Otherwise the positions
of the people waiting near you would be free to scrape by anybody who connects,
and signing in would stop being what earns the sight of them.

**The flood backstop, answered rather than inherited.** Until #150 the 401 at
the upgrade was doing double duty: an unauthenticated flood never reached the
rate limiter, because the session check refused it first. With the socket open,
the limiter has to stand on its own, so anonymous upgrades are:

- counted in a **separate** KV window per address (`POOL_ANON_UPGRADE_LIMIT`,
  20 a minute) — separate so a crowd browsing signed-out on one venue NAT can
  never spend the budget of the signed-in buyers standing next to them, and keyed
  on the address rather than the identity, so minting a fresh anonymous id buys
  nothing. A browser with a demo cookie is *also* counted in a window of its own
  in the same decision, and a buyer refused there is never charged to the
  address, so one phone reconnecting cannot spend the room's budget; and
- **capped concurrently** per address per shard (`POOL_ANON_SOCKETS_PER_IP`,
  20), counted by hibernation tag inside the Durable Object. A window only
  bounds how fast sockets arrive; this bounds how many one address can hold open,
  which is what every queue change fans a `market` count out to.

### Demo pairing

`ALLOW_DEMO_PAIRING` answers exactly one question: **may an anonymous identity
take a seat?** Off, and a signed-out visitor browses and is asked to sign in when
they tap. On, and they pair under a name they type, as below. Everything else —
that a demo pair is never charged and never booked — follows from *who took the
seat*, read off the two user ids, not from a second reading of the flag.

Seating only accounts is right for production and fatal on a stage: without the
two secrets above, sign-in answers 503, so **nobody can take a seat at all**.
There are two deploy scripts, and they leave production in two different modes
— pick the one you mean:

```bash
pnpm run deploy         # strict: sign-in required, matches production
pnpm run deploy:demo    # stage: vite build && wrangler deploy --var ALLOW_DEMO_PAIRING:1
```

`pnpm run deploy` (plain) leaves the site **sign-in-only** — every signed-out
visitor can browse, and every one of them is asked to sign in for a seat. It is
not a "safe default
that also happens to allow demo pairing"; use `deploy:demo` when a stage needs
the escape hatch. Both scripts run the same `vite build && wrangler deploy`
underneath and then print the mode the deployment actually ended up in, read
back from the deployed Worker's own `/api/health` — never from which script you
ran — so a config drift or a stale cached build cannot pass silently.

With demo pairing on, an unauthenticated caller's `demo:` identity may take a
seat, and pairs under a name they type; the UI says on screen that it is pairing
without accounts. The caller may propose a *display name* but never a user id —
the id is minted server-side, on a cookie `/api/health` sets, and is therefore
**sticky per browser**.

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
unauthenticated socket is welcomed but its `join` is refused with
`sign_in_required`; flag on ⇒ two unauthenticated clients pair with each other,
with `demo:` identities and the same $4.49 split.

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

### Honeypot buyers

A market with one buyer in it is indistinguishable from a broken app. The first
person to open NuggBudz in a new city sees a circle, their own dot and nothing —
and the thing they are being asked to believe is precisely that somebody else is
nearby. Separately, nothing in the pool could tell a buyer from something
enumerating the roster or messaging every buddy it was shown.

A **honeypot** is a decoy buyer that answers both. It appears in `waiting` counts
and as a dot, indistinguishable on the map from a real waiting buyer — that is
the point — it can be matched, and it can hold a short conversation. It can
**never** complete a pair.

```bash
HONEYPOT_BUYERS="1"     # in .dev.vars, or `wrangler deploy --var HONEYPOT_BUYERS:1`
```

**That one var answers exactly one question — "do decoys run on this
deployment?" — and it is off unless somebody set it.** It is deliberately
independent of `ALLOW_DEMO_PAIRING`, of `ALLOW_UNCHARGED_PAIRING` and of whether
Stripe is configured. Running decoys on a charged production deployment is
therefore an explicit decision rather than a side effect of which environment
variable happens to be set — and what makes that decision *safe* is the money
gate, never the flag.

#### It cannot take money, and it cannot settle

`paymentDisposition` answers `honeypot` from the two user ids **before the Stripe
secrets are consulted**, exactly as it answers `demo` — so a decoy on a fully
configured deployment cannot reach the processor. From there the rest follows
structurally rather than by timing:

- `codeAtMatchTime('honeypot')` is **false**, so no pickup code is ever released.
- No code released ⇒ `handleConfirmPickup` refuses ⇒ no confirmation is ever
  recorded.
- No confirmation ⇒ `bothConfirmed` never fires ⇒ **no `matches` row**, and every
  route into `disputeMatch` requires one side to have confirmed ⇒ **no `disputes`
  row**.
- No charge ⇒ no ledger ⇒ **no `holds` row** either.
- And no reputation counter: the teardown below books none, and the two other
  teardowns that could reach a decoy match (`cancelMatch`, `handleDisconnect`)
  both name it and skip the `late_cancel` they would otherwise charge the real
  buyer.

#### It excuses itself; it never goes silent

This is the honesty line, and it is the part that would be easiest to get wrong.
A dispute **holds the money** on purpose (see above), and a decoy that simply
stopped answering would walk a real buyer straight into that hold. So a decoy
says the true thing — that it cannot make it — and the match ends through the
**refunding** teardown a buddy who walks away produces (`buddy_left`). The buyer
is returned to the queue, at the back, with no money moved and nothing on their
record.

It happens within `HONEYPOT_BOW_OUT_MS` (45 s), which is armed as a real alarm
deadline and is far inside the ten-minute unconfirmed-match window that would
otherwise cancel the match and charge the buyer for it. Tapping "Handed it over",
or talking past the decoy's last line, only ever gets there sooner.

And a buyer meets **at most one decoy per half hour** in a market
(`HONEYPOT_COOLDOWN_MS`). One phantom buddy is ordinary market seeding; a buyer
paired with a second and a third in a row is being kept in a queue by something
that knows nobody is coming.

#### It is a fallback in matching, never a competitor

`findMatch` drops every decoy from contention the moment any real buyer is
eligible, before the starvation-free fairness window is applied — so the window
is computed over real buyers only and every pairing that could have been real
still is. A chosen decoy is always the **receiver**, whatever it claims to have
waited: the orderer walks to a counter and stands there, and a buyer told to go
and meet somebody who does not exist is the thing this must never do.
`test/matchmaker.test.ts` drives that as a two-hundred-round simulation with
decoys restocked throughout.

#### Chat: canned, offline, and still never stored

A decoy answers from a **fixed table** in `shared/honeypot.ts` — pure,
synchronous, deterministic, no model, no network. That is a deliberate decision
and not a shortcut. The sentence under the chat box says a message goes to your
bud "and nowhere else — not to the ledger, not to us"; handing a buyer's line to
a language model would make that sentence false and would have needed the
sentence changed first. As built, the line is read in memory to pick one of a
handful of replies and is kept nowhere, so `pnpm smoke`'s never-stored scan is
as true for a decoy conversation as for a real one. The only thing persisted is
a *count* of replies, which is what bounds the conversation.

#### The tripwire, and what a human does with it

```
GET /api/admin/honeypot?actor=<users.id>&sinceMs=<epoch>&limit=<n>
```

Behind the same `OPERATOR_USER_IDS` allowlist as disputes and holds, and
**read-only**: a signal is an *observation*, not a case. There is nothing to
resolve and no action endpoint, because nobody decided anything.

Two kinds are recorded, and both are behaviours no legitimate client produces:

| kind | what it means |
|---|---|
| `chat_flood` | the per-connection chat limiter tripped against a decoy. Six messages in ten seconds is not two strangers arranging to meet. |
| `code_guess` | a `confirm_pickup` carrying a pickup code for a match that never released one. The app's own client sends `null` there. |

"Was matched with a decoy" is deliberately **not** a signal: that is the ordinary
cold-start case and would drown the queue on day one.

**Read it like this.** An empty list is the normal answer and is itself
informative. A handful of rows from many different `actorUserId`s is noise —
clients retrying, somebody mashing a button. A *run* of rows from **one**
`actorUserId`, or one `cell`, inside a short window is the thing this exists to
surface, and the action it calls for lives outside this app: revoke that
account's sessions, or ask whoever owns the deployment to rate-limit that caller
at the edge.

A row records which match, which decoy, which caller, which kind and when.
**No chat content, ever** — `migrations/0008_honeypot_signals.sql` has no column
for it, so no future caller can add one by passing a field. The tripwire watching
the relay is not an exception to the promise the relay makes.

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

Buddy reputation landed with it: standing is a band, never a count, and it acts
as a tiebreak inside a window anchored to the longest waiter, so the queue stays
starvation-free.

Next up, tracked as issues: letting the orderer actually place the order at the
counter (#148), and re-matching a requeued buyer without waiting for somebody
new to join (#160). Further out, and not yet filed: payouts to merchants
through Stripe Connect, and an automatic sweep over the holds queue in place of
today's operator-triggered retry.

## Development

This project is developed with [Loom](https://github.com/rjwalters/loom). To run
the full Curator → Builder → Judge → Doctor → Merge lifecycle on a ready issue:

```bash
/loom:sweep <issue>
```

### CI, and why a green pull request is not a green `main`

Every job in `.github/workflows/ci.yml` runs on pull requests **and** on every
push to `main`. That second trigger is not redundant. A pull request's CI tests
the branch's own merge-base and `main`'s tree; it never tests the tree the merge
actually produces. Four times in one afternoon (issue #57) a pull request that
was individually correct and green broke `main` when it landed, and three of the
four merged with **no conflict at all**:

| What merged | How it broke | Conflict? |
|---|---|---|
| A PR that grew `scripts/smoke.mjs` | The deck asserted a stale check count; `main` went red | No — that PR never touched the deck line |
| Two PRs bumping the same deck line | Byte-identical edits for different reasons; the merged file had a third, larger count | No — identical edits merge clean |
| Chain-gated pairing vs. `main`'s fixtures | Fixtures separated buyers with a second and third deal id, which the new gate refused. `vitest` green, dead in `pnpm smoke` | No |
| The same gating vs. another PR's smoke fixtures | That suite paired and settled on the gated chains at five sites | No |

Two of the four were caught only because somebody happened to run the
integration suite locally afterwards, and one had already been sitting on `main`.

**What is in place.** The push-to-`main` trigger (the merge result gets the whole
suite, including `pnpm smoke`, `pnpm test:e2e` and both money lanes), plus a
`main-red-alert` job that turns a red or cancelled push run into **one**
`loom:auditor` tracking issue and comments on that same issue for every later
failure. Nobody has to be watching the Actions tab.

**What needs an operator, and has not been done.** Requiring the suite to pass on
the *combined* tree **before** it lands — the only thing that stops this class
rather than reporting it — is a repo-admin setting, and no workflow or agent
token can grant it to itself (`GET /repos/.../branches/main/protection` answers
`403` for the tokens this project's automation uses). Either of two settings does
it, and a maintainer with admin rights has to choose:

- **Require branches to be up to date before merging** — Settings → Branches →
  branch protection for `main` → *Require status checks to pass* → *Require
  branches to be up to date before merging*. Cheapest to turn on; the cost is that
  every PR must be updated to the newest `main` before it can merge, and with more
  than one PR in flight that serialises merges by hand.
- **A merge queue** — Settings → Branches → *Require merge queue*. Same guarantee
  without the manual updating: the queue builds the combined tree and runs the
  required checks on it. The cost is a longer time-to-merge and a queue to watch.

Either way, the required checks must include the lanes that actually see this
defect class: `smoke` and `e2e`, not only `check`. `pnpm test` was green for two
of the four incidents above.

The decision recorded today is **detect, do not gate** — the alert job ships, the
gate is left to the operator — because the gate's cost is merge friction on a
project where a single agent fleet lands most pull requests, and because nothing
can be enforced from this side of the permission boundary. If the incident rate
comes back, flip the setting rather than adding another notifier.

## License

MIT

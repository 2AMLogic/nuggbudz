---
company: NuggBudz
sector: Local consumer commerce / edge infrastructure
stage: pre-seed
round_target: 'n/a — hackathon pitch; the ask is a pilot cell and a payments rail, not capital'
target_close: 'Hackathon judging'
imagery_policy: deterministic-only
---

# NuggBudz — hackathon pitch brief

Five-minute judging slot, one live two-phone demo, one deck. The audience is
technical: they will believe an architecture claim and disbelieve a market claim,
so the deck spends its credibility budget on the two things that are actually
verifiable in the room — the retail spread and the running system.

## Figures contract (read this before drafting)

**Every money amount, percentage and ratio on a slide comes from the ledger in
`scripts/deck-ledger.ts`**, which derives them from `shared/deals.ts` and
`shared/economics.ts`. `test/deck.test.ts` fails when a slide and the code
disagree. The closed set the drafter may spell:

| Ledger key | Literal | Derivation |
| --- | --- | --- |
| `mcd-nuggets-20.bulk.price` | $7.99 | `bulk.priceCents` |
| `mcd-nuggets-20.solo.price` | $6.99 | `solo.priceCents` |
| `mcd-nuggets-20.solo.total` | $13.98 | `analyzeSpread().soloTotalCents` |
| `mcd-nuggets-20.per.piece.bulk` | $0.40 | `bulk.priceCents / bulk.pieces` |
| `mcd-nuggets-20.per.piece.solo` | $0.70 | `solo.priceCents / solo.pieces` |
| `mcd-nuggets-20.per.piece.ratio` | 1.75× | solo per piece / bulk per piece |
| `mcd-nuggets-20.fee` | $0.99 | `platformFeeCents` |
| `mcd-nuggets-20.collected` | $8.98 | `settle().totalCollectedCents` |
| `mcd-nuggets-20.each.pay` | $4.49 | `settle().shares[0].payCents` |
| `mcd-nuggets-20.each.save` | $2.50 | `settle().shares[0].savingsCents` |
| `mcd-nuggets-20.each.save.pct` | 36% | `settle().shares[0].savingsPct` |
| `mcd-nuggets-20.spread` | $5.99 | `analyzeSpread().grossSpreadCents` |
| `mcd-nuggets-20.spread.pct` | 43% | `analyzeSpread().grossMarginPct` |
| `mcd-nuggets-20.take.pct` | 11% | fee / collected |
| `mcd-nuggets-20.party.savings` | $5.00 | savings summed across the party |
| `mcd-nuggets-20.solo.vs.bulk.pct` | 87% | solo price as a share of the bulk price |
| `mcd-nuggets-20.spread.to.buyers.pct` | 83% | party savings / gross spread |
| `mcd-nuggets-20.spread.to.platform.pct` | 17% | fee / gross spread |
| `wendys-nuggets-20.*` | $8.49, $7.29, $4.74, $2.55, $6.09 | box, solo, each pays, each saves, spread |
| `bk-nuggets-20.*` | $5.99, $4.49, $3.49, $1.00, $2.99 | box, solo, each pays, each saves, spread |
| `volume.{10,25,100}.take` | $9.90, $24.75, $99.00 | fee × pairings |
| `volume.{10,25,100}.savings` | $50.00, $125.00, $500.00 | party savings × pairings |
| `smoke.checks` | 32/32 | `check()` call count in `scripts/smoke.mjs` |

Merchant names are also attested from the catalogue: McDonald's, Wendy's,
Burger King. No other number, name or logo may appear on a slide.

## Problem

Fast-food bulk pricing is inverted, and the inversion is not a promo artifact —
it is how the whole category prices protein. A 20-piece box of McNuggets is
$7.99 while a 10-piece is $6.99: buying half as much food costs 87% of the
larger box. Per nugget that is $0.40 in the 20-piece against $0.70 in the
10-piece, a 1.75× premium for the crime of being one person. Two people standing
in the same queue pay $13.98 for what $7.99 would have bought them, and neither
has any way to find the other.

The people most exposed to this are the people least able to eat the cost:
students, shift workers, anyone eating alone. Splitting requires a second buyer
who is (a) nearby, (b) right now, and (c) a stranger. Nothing in the market
solves (c).

## Why now

Three specific changes, all recent and all necessary:

1. **Chains moved value to bulk bundles.** The cheap unit price is now attached
   to the larger box in every major chain's menu, which is what creates a spread
   to arbitrage at all.
2. **Stateful edge compute became per-object cheap.** Cloudflare Durable Objects
   give one addressable, single-threaded, WebSocket-terminating actor per
   neighbourhood at zero idle cost. Matching a street corner used to mean
   running a regional matchmaking service; it is now one object with a name.
3. **Phones carry both halves of the transaction** — precise location and
   instant payment — so a pairing can settle before the food is cold.

## Solution

A pairing protocol, not a food app. Sign in, pick a deal, share your location
once, and you join the pool for your **cell** — a geohash precision-6 box, roughly
1.2 km × 0.6 km. The moment another buyer in the same cell wants the same box,
both phones are paired over a live socket: the buyer who waited longest is the
orderer and places the order, the other walks over. Both see the identical
itemised settlement to the cent, and a pickup code.

The settlement is the product: $7.99 box plus a $0.99 pairing fee is $8.98
collected, each buyer pays $4.49 and saves $2.50 against the $6.99 they would
have spent alone, the platform clears $0.99.

## Competition

| | What it does | Why it does not solve this |
| --- | --- | --- |
| Chain app bundles (McDonald's, Wendy's, Burger King apps) | Sell the cheap bulk box | Assume one buyer eats 20 nuggets |
| Delivery-app group orders (DoorDash, Uber Eats) | Share a cart via a link | You must already know the other person |
| Splitting with friends | Works perfectly | Requires a friend, in the same place, hungry now |

The gap is strangers. Nobody matches two people who do not know each other by
physical cell in real time, because until edge actors got cheap the
infrastructure was the hard part, and because most consumer apps treat
"introduce two strangers over money" as a support problem rather than a feature.

## Product

Shipped and deployed: <https://nuggbudz.com>

React 19 SPA served by a Cloudflare Worker (Hono), with Google sign-in
(Authorization Code + PKCE) terminating in the Worker. `GET /api/deals` returns the
catalogue with the settlement and spread computed per deal;
`GET /api/pool/ws` upgrades to the matching socket for the caller's cell. Live
matching runs in a Durable Object, `NuggPool`, **one instance per geohash cell**.
D1 is provisioned as the ledger of settled splits.

Architecture claims attested for the deck (all verifiable in the repo):

- The cell is derived from coordinates **server-side** in `worker/index.ts`, not
  accepted from the client, so a caller cannot park in someone else's market.
- Identity is resolved from the session before the socket upgrade, so the name a
  buddy sees cannot be set by a client message (`worker/pool.ts`, `Principal`).
- Durable Objects process one event at a time, so two buyers cannot be paired to
  the same third party — there is no lock, transaction or compare-and-swap in
  `worker/pool.ts`, and none is needed.
- Per-connection state lives in the WebSocket hibernation attachment
  (`serializeAttachment`), not in instance fields, so an idle cell can be
  evicted between the lunch and dinner rushes without losing the queue.
- Matching is first-come-first-served on the waiting side
  (`shared/matchmaker.ts`), which makes the queue starvation-free and makes the
  orderer role fall out of the queue rather than needing a negotiation.
- Money is integer cents everywhere; `divideCents` guarantees the shares sum
  back to the total exactly, and the odd cent goes to the orderer.

## Market

**No top-down market number is attested.** Nothing in this repo supports a TAM
claim, and a fabricated one would be the least credible thing in the room.

What is attested is the unit: **$5.99 of gross retail spread per pairing on the
hero deal, 43% of the $13.98 two solo buyers would otherwise spend**, and the
same spread present in all three catalogue entries ($6.09 Wendy's, $5.99
McDonald's, $2.99 Burger King). The deck sizes the model as arithmetic on that
unit — fee × pairings — and labels it as arithmetic, not a forecast.

## Traction

- Deployed and working at
  <https://nuggbudz.com>, real two-phone pairing
  over WebSockets. As of 2026-09-27 the deployment is the build *before* Google
  sign-in (`/api/health` reports `protocol: 1`), which is why a stranger can
  pair on it without an account.
- `pnpm dev --port 5199` + `pnpm smoke` passes **32/32** end-to-end checks
  across the Worker, the Durable Object, KV and D1 on current `main`: both
  buyers matched to one `matchId`, complementary orderer/receiver roles, each
  paying $4.49, each owed 10 pieces, each saving $2.50, a buddy name taken from
  the session rather than the wire, a 43 m buddy distance, a buyer outside the
  radius left waiting, a survivor requeued when their buddy disconnects, and an
  unauthenticated upgrade refused. Transcript in `refs/smoke-runs.md`, together
  with the 22-check run against the deployment.
- `pnpm test` covers settlement, geo, matchmaking, auth and the wire protocol
  as pure logic, with no Workers runtime.
- No revenue, no users, no LOIs, no pilots. Do not imply otherwise anywhere.

## Business model

$0.99 pairing fee added on top of the box price and split with it: $8.98
collected on a $7.99 box, of which the platform keeps $0.99 — an 11% take on
collected, funded entirely out of a spread the buyers keep 83% of ($2.50 saved
each against $0.99 of fee across the pair). The fee is `platformFeeCents` in the
deal catalogue, per-deal and per-market by construction.

Unit economics stated honestly: payment processing, support and fraud are not
yet in the model, and the deck says so rather than showing a contribution margin
it cannot defend.

## Team

Robb Walters (2AM Logic) — sole author of every commit in this repository.

**No other bio claim is attested.** No prior roles, no prior exits, no named
hires, no advisors. A dedicated team slide is therefore deliberately omitted
(see "Deliberate omissions"); the build itself is the credential and it is on
the slide that shows what shipped.

## Financials

None. No raise, no burn, no runway, no projection. Any financials slide would be
fabrication; it is omitted.

## Ask

Hackathon ask, in this order:

1. **Judges**: pick the demo that runs on real infrastructure — open the URL on
   your own phone during judging and pair with us.
2. **One pilot cell**: a single store cluster and 30 days, to measure the only
   number this deck cannot derive — how long a buyer will wait for a buddy.
3. **A payments rail**: Stripe Connect with the pairing fee taken as an
   application fee, which is the next commit, not a roadmap item.

Milestone the ask buys: the first settled paid split, end to end, with the fee
collected and the D1 ledger row written.

## Prior raises

None. Self-funded hackathon build.

## Assets available

- `figures/src/architecture.mmd` → `figures/architecture.png` (mermaid, drafter-authored)
- `figures/src/per-nugget.py` + `figures/src/per-nugget.csv` → `figures/per-nugget.png`
  (matplotlib; the CSV is generated by `scripts/deck-ledger.ts`, never typed)

No logos, no product screenshots, no team photos, no generative imagery
(`imagery_policy: deterministic-only`). The drafter may not reference any other
image.

## Deliberate omissions

| Canonical slide | Why it is not in the deck |
| --- | --- |
| Team | No attested bio claims beyond authorship; folded into the shipped slide |
| Financials | No revenue, burn or runway exists to show |
| Market (TAM/SAM/SOM) | No defensible sizing input exists; replaced by per-pairing unit arithmetic |

## Outline

The narrative spine lives in `nuggbudz-hackathon.0.outline/outline.md` — one
driving argument plus a per-slide beat and claim. The drafter honours it.

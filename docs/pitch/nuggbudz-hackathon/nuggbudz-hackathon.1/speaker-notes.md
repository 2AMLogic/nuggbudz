# Speaker notes — `nuggbudz-hackathon.1`

Five minutes plus a live demo. One section per slide, in deck order.

## 1. NuggBudz (title)

**Talk track**: Hold up the phone with the app already open. "Fast food prices
bulk cheaper than solo. We pair two strangers standing in the same block to
split one box, and settle it to the cent. It is deployed — you can open it
right now."

**Anticipated questions**: Is this live? (Yes, on the URL.) Is it a real app or
a mock? (Real Worker, real Durable Object, real WebSockets.)

**Backing data**: Deployment URL from `README.md`; verified by the production
smoke run in `refs/smoke-production.md`.

**Drafter notes**: Outline honoured — the beat order in
`nuggbudz-hackathon.0.outline/outline.md` is the slide order; Team and
Financials are cut there with rationale. Effective `imagery_policy:
deterministic-only` (set explicitly in `BRIEF.md`); every image on a slide is
rendered from `figures/src/`.

## 2. Buying for one is the expensive way to buy

**Talk track**: The 20-piece is $7.99. The 10-piece is $6.99 — you pay 87% of
the price for half the food. Two people in the same queue spend $13.98 on what
$7.99 would have bought them, and they have no way to find each other.

**Anticipated questions**: Are these real prices? (They are the catalogue in
`shared/deals.ts` that the deployed API charges; per market and per promo by
construction.) Why not just buy the big box and eat it later? (Cold nuggets;
and the tax falls hardest on whoever is eating alone right now.)

**Backing data**: `mcd-nuggets-20.bulk.price`, `.solo.price`, `.solo.total`,
`.solo.vs.bulk.pct` in the ledger.

## 3. The inversion is the whole category, not a promo

**Talk track**: Per nugget it is $0.40 in the 20-piece against $0.70 solo, a
1.75× premium for buying small. Three chains, same shape — this is not one
promo with an expiry date.

**Anticipated questions**: Does it hold outside these three? (Not attested; we
only claim the catalogue we ship.) Why is Burger King's gap widest? (Its solo
baseline is an 8-piece, so per nugget the solo buyer does worst.)

**Backing data**: `figures/per-nugget.png`, drawn from
`figures/src/per-nugget.csv`, which is generated from the catalogue by
`scripts/deck-ledger.ts`.

## 4. Why now

**Talk track**: Three things had to be true at once. Chains moved value into
the bulk box. Stateful edge compute went per-object cheap, so a street corner
can have its own matching market instead of a regional service. And phones
carry location and payment, so a pairing settles before the food is cold.

**Anticipated questions**: Why not five years ago? (Per-object stateful compute
with WebSocket hibernation is recent; without it the idle cost of one actor per
neighbourhood is the whole business.)

**Backing data**: `BRIEF.md` §"Why now". No market statistic is claimed.

## 5. The protocol

**Talk track**: Pick a deal, share location once, join the pool for your cell —
a geohash precision-6 box, about 1.2 km × 0.6 km. When another buyer in the
same cell wants the same box, both phones pair live. The longest waiter orders,
the other walks over, and both see the same settlement and a pickup code.

**Anticipated questions**: What stops someone claiming a cell they are not in?
(The Worker derives the cell from the coordinates server-side; the client never
names it.) What if my buddy disappears? (The survivor is requeued at the back,
and the smoke run asserts it.)

**Backing data**: `worker/index.ts` (cell derivation), `shared/matchmaker.ts`
(first-come-first-served), `shared/geo.ts` (precision-6 cell size).

## 6. Everyone else assumes you already know the other person

**Talk track**: Chain apps sell the cheap box but assume one buyer eats twenty
nuggets. Delivery group orders share a cart, but you have to already have the
person. Splitting with a friend works perfectly — if you have a friend here and
hungry now. The gap is strangers.

**Anticipated questions**: Why has nobody done this? (Introducing two strangers
over money looks like a support problem until the settlement is exact and
neither party has to negotiate.) Could a chain app add it? (Yes — and the
protocol is a better acquisition channel for them than for us. Say so.)

**Backing data**: `BRIEF.md` §Competition. No competitor number is claimed.

## 7. Who pays what, to the cent

**Talk track**: $7.99 box plus a $0.99 pairing fee is $8.98 collected. Each
buyer pays $4.49 and saves $2.50 — 36% — against the $6.99 they would have
spent alone. The platform keeps $0.99, which is 11% of collected.

**Anticipated questions**: What about the odd cent? (`divideCents` gives it to
the orderer; they are holding the box, and a buyer charged a cent less never
files a ticket.) Is the fee per person or per pairing? (Per pairing, split with
the box.)

**Backing data**: `settle()` in `shared/economics.ts`; ledger keys
`mcd-nuggets-20.collected`, `.each.pay`, `.each.save`, `.each.save.pct`,
`.fee`, `.take.pct`.

## 8. The spread is in every deal in the catalogue

**Talk track**: Three chains, three spreads: $5.99, $6.09 and $2.99 of gross
retail value per pairing. The McDonald's spread is 43% of the $13.98 two solo
buyers would otherwise spend.

**Anticipated questions**: Why is Burger King's smaller? (Its solo baseline is
an 8-piece box, so the comparison also buys the pair more food — the saving
understates the deal.) Do prices vary by store? (Yes; that is why they are a
catalogue row and not a literal at a call site.)

**Backing data**: `analyzeSpread()` per deal; ledger keys `*.spread`,
`mcd-nuggets-20.spread.pct`.

## 9. One Durable Object per geohash cell

**Talk track**: The cell *is* the matching market, so the object's name is the
geohash and routing is a hash rather than a query. Durable Objects process one
event at a time, which is what makes two buyers being paired to the same third
party impossible — there is no lock, transaction or compare-and-swap in
`worker/pool.ts`, and none is needed. Per-connection state lives in the
socket's hibernation attachment, so an idle cell evicts between rushes without
losing the queue.

**Anticipated questions**: What about buyers near a cell boundary? (Today they
are in different markets — an honest limitation; neighbour-cell fan-out is the
obvious next step.) Does a hot cell become a bottleneck? (One cell is one
street corner's worth of traffic; the sharding is the geography.) What happens
on eviction mid-queue? (State is in the attachment, so it survives.)

**Backing data**: `worker/pool.ts`, `worker/index.ts`, `CLAUDE.md`
§Architecture. Cell names in the diagram are computed with the repo's own
`geohash()`.

## 10. It is shipped

**Talk track**: Deployed, and 22/22 end-to-end checks pass against production —
two independent sockets in one cell, complementary roles, identical settlement,
a buyer outside the radius left waiting, a survivor requeued when their buddy
disconnects. The pure logic is tested without a Workers runtime.

**Anticipated questions**: How many users? (None. No revenue, no pilots, no
LOIs. Say it plainly before anyone asks.) Who built it? (One person, in the
hackathon window.)

**Backing data**: `refs/smoke-production.md`; the count is derived from
`scripts/smoke.mjs` by `countSmokeChecks()`.

## 11. Live demo — two phones, one cell

**Talk track**: Run Plan A — judges open the URL on their own phones and pair
with us. That is the strongest version because it is their device, not ours.

**Fallback script, in order**:

1. **Plan A** — judges' phones on venue wifi. Both join, both pair, read the
   settlement off the screen.
2. **Plan B** — our two phones on a personal hotspot. Same flow.
3. **Plan C** — geolocation denied or unavailable: the app falls back to a
   fixed demo cell and says so on screen (`src/hooks/useCoords.ts`). The
   pairing is real; only the coordinate is stipulated. Narrate that out loud —
   a hackathon venue is exactly where GPS dies, and pretending the fix is real
   is the one thing that would cost the audience's trust.
4. **Plan D** — no network at all: read the production run in
   `refs/smoke-production.md` off this deck. It is dated, reproducible, and
   asserts the same settlement the slides quote.

**Anticipated questions**: Is the demo cell a special code path? (No — it is a
coordinate; everything downstream is the same.)

## 12. The model is arithmetic on the fee

**Talk track**: Ten pairings in a cell is $9.90 to the platform and $50.00 of
savings to buyers; a hundred is $99.00 and $500.00. This is arithmetic on the
fee, not a forecast — there is no demand data, and inventing a curve would be
the least credible thing in the deck. What it does show: the fee is funded out
of a spread the buyers keep 83% of.

**Anticipated questions**: What is CAC? (Unknown, and we will not guess.) What
about processing, support and fraud? (Not in this yet, and stated as much.)
What is a realistic pairing rate? (The one number the pilot ask exists to
measure.)

**Backing data**: Ledger keys `volume.*`, `mcd-nuggets-20.party.savings`,
`.spread.to.buyers.pct`, `.spread.to.platform.pct`.

## 13. Ask

**Talk track**: Three asks, in order. Judges: open it on your phone and pair
with us. Second: one pilot cell, one store cluster, thirty days — that measures
the only number this deck cannot derive, which is how long a buyer will wait
for a buddy. Third: a payments rail, Stripe Connect with the fee as an
application fee, which is the next commit rather than a roadmap item. End
there.

**Anticipated questions**: What would you do with money? (Not raising here;
this is a demo and a pilot ask.) What is the first settled paid split worth?
(As a number, $0.99. As a proof, everything.)

## 14. Appendix — every figure here is derived, not typed

**Talk track**: For the judge who wants to audit: `shared/deals.ts` and
`shared/economics.ts` are the only sources of money in this deck.
`scripts/deck-ledger.ts` derives every figure and `test/deck.test.ts` fails if
a slide disagrees, in either direction — a number on a slide the code does not
produce, or a number the code produces that the deck dropped.

**Backing data**: `test/deck.test.ts`, run by `pnpm test`.

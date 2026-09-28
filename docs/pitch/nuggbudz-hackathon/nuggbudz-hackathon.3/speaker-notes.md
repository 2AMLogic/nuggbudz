# Speaker notes — `nuggbudz-hackathon.3`

Five minutes plus a live demo. One section per slide, in deck order. Changes
from `.2` are logged in `_revision-log.md`.

## 1. NuggBudz (title)

**Talk track**: Hold up the phone with the app already open. "Fast food prices
bulk cheaper than solo. We pair two strangers standing in the same block to
split one box, and settle it to the cent. It is deployed — you can open it right
now."

**Anticipated questions**: Is this live? (Yes, on the URL.) Is it a real app or
a mock? (Real Worker, real Durable Object, real WebSockets.)

**Backing data**: Deployment URL from `README.md`; end-to-end runs in
`refs/smoke-runs.md`.

**Reviser notes**: Outline honoured — the beat order in
`nuggbudz-hackathon.0.outline/outline.md` is the slide order; team, financials
and market-sizing slides are cut there with rationale. Effective
`imagery_policy: generative-eligible` from `.3` onwards: the two deterministic
figures still render from committed sources in `figures/src/`, and the
generative imagery is dispatched by `deck-imagegen` from the prompts at the
end of this file, with every prompt, model and hash recorded in
`assets/_prompts.json`.

## 2. The spread is real (divider)

**Talk track**: Two seconds, then move. "The price difference is already on the
menu. Everything after this slide is arithmetic on it."

**Anticipated questions**: None — do not stop here.

**Backing data**: None on the slide. The figures are on slides 3 and 4.

## 3. Buying for one is the expensive way to buy

**Talk track**: The 20-piece is $7.99. The 10-piece is $6.99 — you pay 87% of
the price for half the food. Two people in the same queue spend $13.98 on what
$7.99 would have bought them, and they have no way to find each other.

**Anticipated questions**: Are these real prices? (They are the catalogue in
`shared/deals.ts` that the deployed API charges; per market and per promo by
construction.) Why not buy the big box and eat it later? (Cold nuggets; and the
tax falls on whoever is eating alone right now.)

**Backing data**: ledger keys `mcd-nuggets-20.bulk.price`, `.solo.price`,
`.solo.total`, `.solo.vs.bulk.pct`.

## 4. The inversion is the whole category, not a promo

**Talk track**: Per nugget it is $0.40 in the 20-piece against $0.70 solo, a
1.75× premium for buying small. Three chains, same shape — not one promo with an
expiry date.

**Anticipated questions**: Does it hold outside these three? (Not attested; we
claim only the catalogue we ship.) Why is Burger King's gap widest? (Its solo
baseline is an 8-piece, so per nugget the solo buyer does worst.)

**Backing data**: `figures/per-nugget.png`, drawn from
`figures/src/per-nugget.csv`, which is generated from the catalogue by
`scripts/deck-ledger.ts` and asserted byte-for-byte by `test/deck.test.ts`.

## 5. Why now

**Talk track**: Three things had to be true at once. Chains moved value into the
bulk box. Stateful edge compute went per-object cheap, so a whole metro's live
matching fits in one addressable actor instead of a regional service with a
queue — a 2-mile radius, not the actor's own boundary, is what decides who can
pair inside it. And phones carry location and payment, so a pairing settles
before the food is cold.

**Anticipated questions**: Why not five years ago? (Per-object stateful compute
with WebSocket hibernation is recent; without it, the idle cost of one actor per
neighbourhood is the whole business.)

**Backing data**: `BRIEF.md` §"Why now". No market statistic is claimed.

## 6. Finding the second buyer (divider)

**Talk track**: "The spread is worth nothing until someone finds the other buyer
while they are both still hungry. That is the product."

**Anticipated questions**: None — this is the pivot from the money half of the
deck to the system half.

**Backing data**: None on the slide.

## 7. The protocol

**Talk track**: Sign in, pick a deal, join the pool — there is no location
prompt anywhere in the flow. The server places you in your **shard** — a
coarse geohash box sized so a 2-mile radius always sits inside it. When
another buyer within that 2-mile radius wants the same box, both phones pair
live. The longest waiter orders, the other walks over, and both see the same
settlement and a pickup code.

**Anticipated questions**: What stops someone claiming a market they are not
in? (The Worker derives both the shard and the radius from the coordinates
server-side; the client never names either.) Can I pretend to be someone else?
(No — the display name your buddy sees is read off the session, not off the
join message.) What if my buddy disappears? (The survivor is requeued at the
back, and the smoke run asserts it.)

**Backing data**: `worker/index.ts` (shard + identity resolved before the
upgrade), `worker/pool.ts` (`Principal` from the session, `radiusMeters` for
match eligibility), `shared/matchmaker.ts` (first-come-first-served),
`wrangler.jsonc` (`POOL_CELL_PRECISION`, `MATCH_RADIUS_METERS`).

## 8. Everyone else assumes you already know the other person

**Talk track**: Chain apps sell the cheap box but assume one buyer eats twenty
nuggets. DoorDash and Uber Eats group orders share a cart, but you must already
have the person. Splitting with a friend works perfectly — if you have a friend
here and hungry now. The gap is strangers.

**Anticipated questions**: Why has nobody done this? (Introducing two strangers
over money looks like a support problem until the settlement is exact and
neither party has to negotiate.) Could a chain app add it? (It could — and it
would pool only its own buyers in its own app. Liquidity is the product, and
liquidity is cross-merchant and cross-cell. Say this out loud; it is the moat
claim.)

**Backing data**: `BRIEF.md` §Competition. No competitor number is claimed.

## 9. Who pays what, to the cent

**Talk track**: $7.99 box plus a $0.99 pairing fee is $8.98 collected. Each
buyer pays $4.49 and saves $2.50 — 36% — against the $6.99 they would have spent
alone. The platform keeps $0.99, which is 11% of collected.

**Anticipated questions**: What about the odd cent? (`divideCents` gives it to
the orderer; they are holding the box, and a buyer charged a cent less never
files a ticket.) Is the fee per person or per pairing? (Per pairing, split with
the box.)

**Backing data**: `settle()` in `shared/economics.ts`; ledger keys
`mcd-nuggets-20.collected`, `.each.pay`, `.each.save`, `.each.save.pct`, `.fee`,
`.take.pct`.

## 10. The spread is in every deal in the catalogue

**Talk track**: Three chains, three spreads: $5.99, $6.09 and $2.99 of gross
retail value per pairing. The McDonald's spread is 43% of the $13.98 two solo
buyers would otherwise spend.

**Anticipated questions**: Why is Burger King's smaller? (Its solo baseline is
an 8-piece box, so the comparison also buys the pair more food — the saving
understates the deal.) Do prices vary by store? (Yes; that is why they are a
catalogue row and not a literal at a call site.)

**Backing data**: `analyzeSpread()` per deal; ledger keys `*.spread`,
`mcd-nuggets-20.spread.pct`.

## 11. One Durable Object per shard — a 2-mile radius decides who pairs

**Talk track**: The object's name is a coarse geohash — a **shard**, not the
market — chosen so a 2-mile radius always sits inside one rather than being
clipped by it; routing is still a hash rather than a query. The **radius** is
the matching market: it alone decides who can pair, enforced inside the shard
rather than by the shard's own boundary. Durable Objects process one event at a
time, which is what makes two buyers being paired to the same third party
impossible — there is no lock, transaction or compare-and-swap in
`worker/pool.ts`, and none is needed. Per-connection state lives in the socket's
hibernation attachment, so an idle shard evicts between rushes without losing
the queue.

**Anticipated questions**: What about buyers near a shard boundary? (The shard
is coarse enough — precision-3 geohash, roughly 156 km — that a 2-mile radius
fits fully inside it almost everywhere; the radius, not the shard, is what
decides pairing regardless.) Does a hot shard become a bottleneck? (One shard
can be a whole metro's worth of traffic in one single-threaded object; the
precision stays a var, so coarsening trades contention for correctness and is
the first knob to turn if contention ever becomes real.) What happens on
eviction mid-queue? (State is in the attachment, so it survives.) Where does
identity come from? (The Worker resolves the session before the upgrade and
passes the principal down; a `name` on the wire is ignored.)

**Backing data**: `worker/pool.ts` (`radiusMeters`), `worker/index.ts`,
`wrangler.jsonc` (`POOL_CELL_PRECISION`, `MATCH_RADIUS_METERS`), `CLAUDE.md`
§Architecture. The shard names and distances in the figure are computed with
the repo's own `geohash()` / `distanceMeters()` — see the comment block in
`figures/src/architecture.mmd`.

## 12. Deployed, and verified end to end

**Talk track**: Deployed, and every end-to-end check passes across the Worker,
the Durable Object, KV and D1 — two independent sockets in one cell,
complementary roles, identical settlement, a buddy name that comes from the
session rather than the wire, a buyer outside the radius left waiting, a
survivor requeued when their buddy disconnects, and the two-sided pickup
handshake: only the orderer holds the code, a wrong code settles nothing, and a
row reaches the ledger only when both sides confirm. Two of those checks are the
ones that matter on a borrowed phone: a socket that sends no coordinates at all
still gets a cell and still pairs, because the location comes from the edge.
Then say the fourth bullet: no users, no revenue, no pilot.

**Anticipated questions**: Is that against production? (The full run is
against a full local stack — `pnpm dev` plus the real bindings — because the
pool socket now requires a session and `pnpm smoke` seeds sessions into the
local KV namespace. The deployment is behind `main`,
and it passed its own 22-check run today. Both are in `refs/smoke-runs.md`.)
Who built it? (An agent-orchestrated pipeline, in the hackathon window — Curator, Builder, Judge, Doctor and Champion, merging as `rjwalters` and `turian`.)

**Backing data**: `refs/smoke-runs.md`. The slide names no count on purpose
— see "Why the deck does not quote a check count" there.

## 13. Live demo — two phones, one cell

**Talk track**: Run Plan A — judges open the URL on their own phones and pair
with us. Strongest version, because it is their device and the deployed build
runs with demo pairing enabled, so there is no account to create.

**Fallback script, in order**:

1. **Plan A** — judges' phones on venue wifi. Both join, both pair, read the
   settlement off the screen.
2. **Plan B** — our two phones on a personal hotspot. Same flow.
3. **Plan C** — a refused or unavailable location: nothing to recover from, and
   nothing to click. There is no permission prompt in the pairing flow at all;
   the Worker places each socket from Cloudflare's edge geo, and from a fixed
   demo cell when there is no usable one (`shared/location.ts`). The screen names
   which of the three rungs placed you, and only the opt-in one is ever called
   exact. The pairing is real; on the last rung only the coordinate is
   stipulated. Narrate that out loud — a hackathon venue is exactly where GPS
   dies, and pretending the fix is real is the one thing that would cost the
   audience's trust.
4. **Plan D** — no network at all: read the recorded runs in
   `refs/smoke-runs.md` off this deck. Dated, reproducible, and they assert the
   same settlement the slides quote.

**Anticipated questions**: Is the demo cell a special code path? (No — it is a
coordinate; everything downstream is the same.) Do we need Google sign-in on
stage? (Not on the deployed build. If we demo local `main`, sign-in is required
and the OAuth client must be configured — that is Plan B's failure mode, so
keep Plan A first.)

## 14. The model is arithmetic on the fee

**Talk track**: Ten pairings in a cell is $9.90 to the platform and $50.00 of
savings to buyers; a hundred is $99.00 and $500.00. That column is fee revenue,
gross of processing, support and fraud — we would rather name the exclusion than
guess a rate. This is arithmetic, not a forecast: there is no demand data, and
inventing a curve would be the least credible thing in the deck. What it does
show is that the fee is funded out of a spread the buyers keep 83% of.

**Anticipated questions**: What is CAC? (Unknown, and we will not guess.) Does a
merchant have to agree to the fee? (No — the merchant is paid full menu price by
the orderer and is not a counterparty in this model.) What is a realistic
pairing rate? (The one number the pilot ask exists to measure.) What happens
when a buddy vanishes after the order is placed? (Technically the survivor is
requeued; economically that is a dispute path we have not priced, and the pilot
is where it gets measured.)

**Backing data**: ledger keys `volume.*`, `mcd-nuggets-20.party.savings`,
`.spread.to.buyers.pct`, `.spread.to.platform.pct`.

## 15. Ask

**Talk track**: Judges — open it on your phone and pair with us; that is the
ask you can act on in this room. Then one pilot cell: one store cluster, thirty
days, to measure the one number this deck cannot derive, which is how long a
buyer will wait for a buddy. That pilot buys the first settled paid split, with
Stripe Connect taking the pairing fee as an application fee — the next commit,
not a roadmap item. End on the ask, then take questions.

**Anticipated questions**: What would you do with money? (Not raising here; this
is a demo and a pilot ask.) What is the first settled paid split worth? (As a
number, $0.99. As a proof, everything.)

## 16. Appendix — every figure here is derived, not typed

**Talk track**: For the judge who wants to audit: `shared/deals.ts` and
`shared/economics.ts` are the only sources of money in this deck.
`scripts/deck-ledger.ts` derives every figure and `test/deck.test.ts` fails if a
slide disagrees, in either direction — a number on a slide the code does not
produce, or a number the code produces that the deck dropped.

**Worth saying if asked**: this already caught a real drift. Google sign-in
landed mid-authoring, `scripts/smoke.mjs` grew from 22 assertions to 32, and the
deck failed its own test until the slide was corrected. Nobody noticed by
reading; the build did.

**Backing data**: `test/deck.test.ts`, run by `pnpm test`.

---

# Imagery prompts

`deck-imagegen` resolves one prompt per `<!-- anvil-imagegen: <slot> -->` marker
in `deck.md` from the sections below. **Only the first paragraph of each section
is dispatched**; anything after the first blank line is a note for a human and
never reaches the backend. The `nugg-1996-composite` preset supplies the house
style and the guardrails (no brand marks, no trade dress, no recognisable
storefront, no identifiable faces) around every one of them — see
`.anvil/skills/deck/assets/imagery-style-presets.md`.

Two rules the prompts below are written to. **A prompt is an outbound
transmission** to Google or Cloudflare, so no credentials, host names or account
ids appear in any of them. And **no merchant is named**: the deck is about
splitting a real merchant's real product, so every scene is a generic counter, a
generic car park, a generic pavement, and the synthetic object on top is what
makes it unmistakably an illustration rather than a photograph of someone's
restaurant.

## Imagery prompt: title-counter

A single faceted amber polygon nugget the size of a fist resting on the scuffed stainless steel ledge of an anonymous quick-service kitchen pass. The photographic half is the steel, the crumbs, the warm overhead strip light and the out-of-focus tiled wall behind it; the synthetic half is only the nugget itself and a small black and white checkerboard mat that runs out from under it and dies at a hard straight seam where the real steel continues. There is no rectangular panel, no screen, no monitor, no backdrop flat and no floating frame anywhere in the picture: the synthetic object sits directly on the real surface and the photograph fills the whole frame behind it. Subject centred and large in the frame, shot slightly from above, with room above and below so the picture survives a tall crop.

Used as `![bg right:44%]` on the title slide, so it is cropped to a tall panel —
the composition has to hold up at roughly 4:5 rather than 16:9.

## Imagery prompt: divider-spread

A supermarket-sized faceted amber polygon nugget sitting alone in the middle of a real, empty tarmac car park at dusk: wet asphalt, painted bay lines, one sodium lamp flaring at the edge of the frame. Behind it, standing where the real sky would be, a banded indigo to magenta gradient panel with hard visible steps, like a backdrop flat propped up on the tarmac. A black and white checkerboard plane spreads out from under the nugget across the asphalt and stops at a hard straight seam. Wide, low camera, the nugget small in a large empty frame.

Full-bleed divider at `brightness:0.45`, so it is read through a heavy dark
overlay: one big simple silhouette, nothing that depends on fine detail.

## Imagery prompt: divider-protocol

Two ordinary unbranded phones lying face up on a real formica table top, photographed from directly above in available light. Rising out of each screen is a flat shaded amber polygon nugget half, hard faceted, one blown out specular each, and a single hard phosphor green line drawn straight between them across the table. A black and white checkerboard plane runs out from under the phones and stops at a hard straight seam where the real formica continues. Top down, symmetrical, with a lot of empty table around the pair.

Full-bleed divider at `brightness:0.45`. The green line between the two phones
is the one thing that has to survive the overlay — it is the pairing.

## Imagery prompt: protocol-pavement

A real city pavement photographed from above in flat daylight: worn concrete slabs, a drain cover, a cigarette end, a little grit. Painted onto it, obviously synthetic, two black and white checkerboard squares a few paces apart, each with a small faceted amber polygon nugget standing on it, and one hard phosphor green line running between the two squares. Vertical composition with the two squares stacked one above the other so the frame survives a tall crop.

`![bg right:34%]` beside the numbered protocol steps. The two squares are the
two buyers and the green line is the socket; keep it literal.

## Imagery prompt: market-counter

A plain anonymous service counter photographed straight on in a real, ordinary cafeteria: bare laminate, a steel edge strip, a tiled wall behind, no signage, no menu boards, no printed packaging and no branding of any kind. Standing along the counter in a receding row, obviously synthetic, five identical faceted amber polygon boxes, each one comically too large for one person, flat shaded with hard edges and one blown out specular apiece. A black and white checkerboard mat runs along the counter top under the boxes and stops at a hard straight seam where the real laminate continues. There is no rectangular panel, no screen, no monitor, no backdrop flat and no floating frame anywhere in the picture: the synthetic object sits directly on the real surface and the photograph fills the whole frame behind it. The nearest box is large in the frame and the row recedes away from the camera, so the picture survives a tall crop taken through its middle.

`![bg right:32%]` beside the competitor table. The point of the image is the
absurdity of the bulk box as a single-buyer product — five boxes, nobody to
split them with.

## Imagery considered and cut

Two more slots were prompted, generated and looked at, then cut before this
revision shipped. Both images exist in the history of this branch and neither is
in the tree: an image that is merely decorative makes a deck worse, and the
review pass is where a non-additive image is supposed to die.

- **`deployed-edge`** — a real street cabinet at night with a low-polygon globe
  balanced on it, for slide 12. The render was good and the idea was wrong: a
  globe says *global*, which is a scale claim this deck deliberately does not
  make (there is no sizing input, which is why the market slide is unit
  arithmetic). It would have put a claim in a picture that the words refuse to
  make.
- **`demo-phones`** — two real phones propped on a kerb, each screen showing the
  banded sky and a faceted nugget, for slide 13. It was the best-looking of the
  eight. It was also redundant twice over: slide 6's divider already carries two
  phones and a green line between them, and slide 13's whole promise is that two
  *real* phones are about to pair in the room. A picture of the thing you are
  about to do live competes with doing it.

## Imagery prompt: ask-bench

A plain brown paper takeaway bag standing closed on a real wooden park bench at dusk, photographed in available light, with no printing or branding anywhere on the bag. Hovering just above the bag, obviously synthetic, a single faceted amber polygon nugget, flat shaded, hard edges, one blown out specular, throwing a hard amber cast onto the top of the bag that nothing in the real scene could have produced. A small patch of black and white checkerboard sits under the bag and stops at a hard straight seam at the edge of the slats. There is no rectangular panel, no screen, no monitor, no backdrop flat and no floating frame anywhere in the picture: the synthetic object sits directly on the real surface and the photograph fills the whole frame behind it. The bag and the nugget sit together just right of centre, large in the frame, so the picture survives a tall crop taken through them.

`![bg right:36% brightness:0.85]` on the ask slide. The bag is the handoff: the
thing one buyer carries to the other.

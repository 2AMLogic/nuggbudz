# Outline — `nuggbudz-hackathon`

Read-only once written (anvil:deck §"outline sibling"). The drafter honours the
beat and claim assignment below; the reviser never edits this file.

## Driving argument

The spread is real and arithmetic, the second buyer is the only missing piece,
and one Durable Object per geohash cell is the cheapest correct way to find them
— which is why this is a deployed system rather than a pitch about one.

Everything on a slide either (a) proves the spread exists, (b) proves the
matching problem is solved, or (c) asks for the one thing the code cannot
produce: a real cell full of hungry strangers. A slide that does none of those
three is cut.

## Audience and slot

Technical hackathon judges, 5 minutes, one live demo. They will believe an
architecture claim they can read and disbelieve a market claim they cannot. So
the credibility budget goes to the spread and the running system; there is no
TAM slide, because no input in this repo supports one.

## Beats

| # | Slide | Beat | Load-bearing claim |
| --- | --- | --- | --- |
| 1 | Title | Orient | A pairing protocol for splitting bulk fast food, live on a URL you can open now |
| 2 | Problem | Establish the tax | The 10pc costs 87% of the 20pc: buying for one is the expensive way to buy |
| 3 | Per-nugget economics | Generalise it | $0.40 against $0.70 a nugget, 1.75× — and the inversion holds across all three chains in the catalogue |
| 4 | Why now | Open the window | Bulk-only value pricing, plus per-object stateful edge compute, plus phones that carry location and payment |
| 5 | Solution | Show the mechanic | One location share → the cell pool → longest waiter orders → identical settlement to the cent |
| 6 | Competition | Name the gap | Every existing answer assumes you already know the other person |
| 7 | Settlement | Make the money concrete | $8.98 collected, $4.49 each, $2.50 saved each (36%), $0.99 to the platform |
| 8 | Catalogue | Prove it is not one deal | $5.99 / $6.09 / $2.99 of gross retail spread per pairing across three chains |
| 9 | Architecture | Earn the technical vote | The cell *is* the matching market; DO single-threadedness makes double-pairing impossible with no lock |
| 10 | Shipped | Establish it is real | Deployed, and 22/22 end-to-end checks pass against production |
| 11 | Live demo | Prove it in the room | Two phones pair over a live socket; a scripted fallback if venue wifi or geolocation dies |
| 12 | Take rate | Show the model | Fee × pairings, labelled as arithmetic; the spread splits 83% buyer / 17% platform |
| 13 | Ask | Close | Judges' pick, one pilot cell for 30 days, a payments rail |
| 14 | Appendix | Defend the numbers | Every figure on these slides is derived from the code and asserted by `pnpm test` |

## Cuts made at outline time

- **Team slide** — cut. Only one bio claim is attested (authorship), and a slide
  carrying one line would spend a slide on nothing. Folded into beat 10.
- **Financials slide** — cut. No revenue, burn or runway exists; a projection
  chart would be the least defensible object in the deck.
- **Market (TAM/SAM/SOM) slide** — cut and replaced by beat 12. Top-down sizing
  with no attested input is a market-math critical flag waiting to happen; the
  per-pairing unit arithmetic is defensible and derived.
- **Product screenshot slide** — cut. `imagery_policy: deterministic-only` and
  no screenshots exist in `assets/`; beat 11 shows the product live instead,
  which is strictly better than a screenshot of it.

## Ordering rationale

The problem (2–3) is arithmetic, so it lands before any assertion about
behaviour. "Why now" (4) precedes the solution so the architecture reads as a
consequence of cheap edge actors rather than a preference. Competition (6) sits
ahead of the money slides so "strangers" is already established as the gap the
fee is charged for. The demo (11) lands after the system has been shown to work
(9–10), so a wifi failure costs the audience a spectacle and not the argument.
The ask (13) is last; the appendix is for the judge who wants to audit the
numbers afterwards.

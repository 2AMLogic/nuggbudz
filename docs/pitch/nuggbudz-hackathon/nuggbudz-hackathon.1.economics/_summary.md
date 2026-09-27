---
critic: economics
critical_flag: false
rubric_id: anvil-deck-v3
---

# Economics critic — partial scorecard for `nuggbudz-hackathon.1`

Adversarial pass over the settlement slide (7), the catalogue slide (8) and the
take-rate slide (12), plus `figures/src/per-nugget.csv`.

| # | Dimension | Score | Weight |
| --- | --- | --- | --- |
| 1 | Narrative arc | null | 6 |
| 2 | Problem clarity | null | 5 |
| 3 | Market size credibility | null | 5 |
| 4 | Solution differentiation | null | 5 |
| 5 | Traction / proof | null | 5 |
| 6 | Team credibility | null | 4 |
| 7 | Ask specificity | null | 5 |
| 8 | Design polish | null | 5 |
| 9 | Rhetorical economy | null | 4 |
| 10 | **Business-model & unit-economics credibility** | **3** | 5 |

**Dim 10 = 3/5.** The revenue mechanic is unambiguous and unusually well
evidenced: a flat $0.99 per pairing, added on top of the box and split with it,
implemented as `platformFeeCents` per catalogue row, with the take shown against
both collected revenue (11%) and the spread it is funded from (17%). Most decks
at this stage cannot say that precisely. Two things hold it to 3:

1. **No cost line anywhere on a slide.** Payment processing, support and fraud
   are excluded, and only the speaker notes admit it. A reviewer reading the
   deck alone would take $0.99 as contribution, which it is not — on an $8.98
   charge, card processing alone is a material fraction of the fee.
2. **No counterparty-acceptance evidence.** Nothing establishes that a buyer
   accepts a $0.99 charge on a $4.49 purchase beyond the (good) argument that
   they keep 83% of the spread. No comparable rev-share or pricing substrate is
   cited; there is no perspective sibling, so no substrate uplift is available.

**Independent recomputation** (from `shared/deals.ts`, not from the slides):
collected 799 + 99 = 898; `divideCents(898, 2)` = [449, 449]; savings 699 - 449
= 250 each, 500 across the party; spread 1398 - 799 = 599; buyers' share
500/599 = 83.5% -> 83%, platform 99/599 = 16.5% -> 17%. Take on collected
99/898 = 11.0%. Volume rows 99 x {10,25,100} and 500 x {10,25,100} are exact.
**No arithmetic error and no internal contradiction.**

No critical flag: the revenue mechanic is stated, coherent, and not
counterparty-rejecting on its face.

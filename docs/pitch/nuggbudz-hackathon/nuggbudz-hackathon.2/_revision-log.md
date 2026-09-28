# Revision log — `nuggbudz-hackathon.1` → `.2`

Every finding from the five critic siblings at `.1`, and what was done with it.
Aggregate at `.1`: 36/49, no critical flags.

## Blocking findings (from `.1.review/verdict.md`)

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | `[design, blocker]` Ask-slide URL illegible (code span on the dark `_class: ask` field) | **Fixed.** Backticks dropped; the URL is plain italic text on slide 13. Verified in the re-rendered PDF. |
| 2 | `[design, major]` Empty leading header cells on slides 7 and 11 | **Fixed.** Real headers: `Line`/`Amount` on the settlement table, `Plan`/`What happens` on the demo table. |
| 3 | `[narrative, major]` Slide 13 compressed three asks into one line | **Fixed.** The judge-facing ask is now the headline; the pilot ask is one sentence naming what it buys; the payments rail moved to the speaker notes, where a commitment belongs. |
| 4 | `[economics, major]` Slide 12 presented fee revenue as if it were contribution | **Fixed.** The supporting line now opens "Gross of processing, support and fraud." No processing rate was invented — naming the exclusion is the honest version. |

## Recommended findings

| # | Finding | Disposition |
| --- | --- | --- |
| 5 | `[market, minor]` Name DoorDash and Uber Eats; add a moat clause | **Fixed.** Competitor rows name the chains and the delivery apps (both already attested in `BRIEF.md`); a supporting line states the moat: liquidity is cross-merchant and cross-cell. |
| 6 | `[design, minor]` Phones and pools share one fill in the architecture figure | **Fixed.** Phones render white with a muted stroke via a `client` classDef; the `NuggPool` nodes keep the accent fill. |
| 7 | `[design, minor]` In-bar chart labels below comfortable projection size | **Fixed.** Raised to 14pt and shortened to the piece count (`10pc` / `20pc` / `8pc`); the full item name is still in `per-nugget.csv`. |
| 8 | `[narrative/design, nit]` Slide 10 heading was a label | **Fixed.** Now asserts the claim. |
| 9 | `[review, minor]` "No users yet" lived only in the notes | **Fixed.** On the slide as its own bullet, in bold. |

## Declined

| Finding | Why |
| --- | --- |
| Close the dim 3 gap with a sizing slide | Declined, per `.1.review/verdict.md` §"Not to be fixed". No input in this repository supports a defensible sizing case, and a top-down number would be a market-math critical flag. The pilot ask exists to buy the missing input. |
| Close the dim 6 gap with a team slide | Declined. One bio claim is attested (sole authorship) and it is already on slide 10. A padded team slide would be fabrication. |
| Net out a processing rate on slide 12 | Declined. We do not have a rate; naming the exclusion beats guessing one. |

## Out-of-band correction: `main` moved under the draft

While `.1` was being critiqued, Google sign-in landed on `main` (`ec0aec7`,
merged as #13) and this thread was rebased onto it. Three claims in `.1` became
false and were corrected here, none of them found by a critic:

- **The check count changed.** `scripts/smoke.mjs` grew from 22 assertions to
  32. The deck's own drift test (`test/deck.test.ts`) failed on the stale
  `22/22` literal, which is exactly the mechanism the appendix slide claims —
  the correction was forced by a red build, not by proofreading.
- **The 32-check run is no longer against production.** The pool socket now
  requires a session and `pnpm smoke` seeds sessions into a local KV namespace,
  so the reproducible run is `pnpm dev` + `pnpm smoke`. Slide 10's heading was
  corrected from "verified against production" to "verified end to end", and
  `refs/smoke-runs.md` records both runs with their commits.
- **The flow starts with sign-in.** Slide 5 step 1 now says so, and the
  architecture figure notes that the Worker resolves cell *and* identity before
  the upgrade — a strictly better version of the "the server derives the cell"
  claim, since a client can no longer name itself either.

The economics are untouched: `shared/deals.ts` and `shared/economics.ts` did not
change in that merge, so every money figure in the deck is the same one the
ledger derived at `.1`.

## Out-of-band correction: the cell became a shard, the radius became the market (#88)

Issue #82 (PR #89) changed `POOL_CELL_PRECISION` 6 → 3 and `MATCH_RADIUS_METERS`
800 → 3219 (two miles): the geohash cell is now a coarse shard sized to hold a
whole metro, and the 2-mile radius — not the shard's own boundary — is the only
thing that decides who can pair. The architecture figure's central claim, "the
cell is the matching market," and the same claim repeated in the protocol slide,
the "why now" slide and their speaker notes, and in `nuggbudz-hackathon/BRIEF.md`,
were the one thing that had stopped being true. Corrected everywhere it appeared
in the live deck; the Durable Object's "one event at a time, so double-pairing
cannot happen" point — unaffected by the unit change — was kept. `test/deck.test.ts`
does not catch this class of drift: it derives money, not prose, so the guard
stayed green through the whole time the claim was wrong.

## Gaps carried forward

- No `deck-vision` pass (vision dims v1–v6 unscored). The design critic reviewed
  the rendered PDF page by page, which covers the same rendered-only defects for
  a deck this size, but the gap is recorded rather than papered over.
- No perspective sibling, so dims 3, 4 and 10 score against the pre-perspective
  baseline with no substrate uplift available.

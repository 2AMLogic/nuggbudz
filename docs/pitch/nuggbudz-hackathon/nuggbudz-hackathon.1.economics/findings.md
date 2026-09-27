# Economics findings — `nuggbudz-hackathon.1`

## major — slide 12 presents the fee as if it were contribution

"Platform | $9.90 / $24.75 / $99.00" is gross fee revenue. Processing, support
and fraud are all excluded, and the exclusion is disclosed only in the speaker
notes. On a deck slide read without the notes, this overstates unit economics —
the exact failure mode dim 10 exists to catch.

**Fix**: state the exclusion inline on the slide (one clause on the supporting
line, "before processing"). Do not invent a processing rate to net it out;
naming the exclusion is enough and is more defensible than a guessed number.

## minor — no counterparty-acceptance evidence for the $0.99 fee

The buyer-side argument is good (they keep 83% of the spread) but it is an
argument, not evidence. The merchant side is untouched: today the chain is paid
full menu price by the orderer and is not a counterparty to the fee at all —
worth saying, because a reviewer will assume a merchant rev-share negotiation is
hiding somewhere.

**Fix**: one clause in the speaker notes confirming the merchant is not a
counterparty in the current model, so the fee needs no merchant consent.

## minor — no contribution-margin trace at scale

The take-rate table scales revenue linearly with pairings, which is correct for
a flat fee, but nothing states what does *not* scale linearly (support per
disputed pickup, refunds when a buddy vanishes after ordering). The product
already handles the technical half of that case — the survivor is requeued — so
the economic half is a fair question.

**Fix**: acknowledge the dispute path in the notes; the pilot ask is the right
place to promise the measurement.

## Verified, no action

- The fee is data, not a literal: `platformFeeCents` per catalogue row, so a
  per-market fee change flows through `settle()` and the deck's ledger together.
- Chart data (`figures/src/per-nugget.csv`) is generated from the catalogue and
  asserted byte-for-byte by `test/deck.test.ts` — the figure cannot drift from
  the prices independently of the slides.

# Economics findings — `nuggbudz-hackathon.2`

## Resolved from `.1`

| `.1` finding | Status |
| --- | --- |
| major — fee presented as contribution | Resolved on the slide, not only in the notes |
| minor — no counterparty-acceptance framing | Partially resolved: the merchant-is-not-a-counterparty point is in the notes |
| minor — no dispute-path acknowledgement | Resolved in the notes (requeue is technical; the economics are unpriced and named as such) |

## carried — no contribution-margin trace

Still nothing that takes $0.99, subtracts the real costs of collecting it, and
lands on a per-pairing contribution figure. This is the correct gap to carry
into a pilot rather than to guess at, but it is the reason dim 10 is not 5/5.

**What would close it**: a Stripe Connect fee schedule applied to an $8.98
charge, plus an observed dispute rate from the pilot. Both are downstream of the
ask.

## nit — the savings column is the strongest number on the slide

"Buyer savings unlocked" is what makes a flat consumer fee defensible in a way a
take-rate percentage never does. If a slide has to be cut for time, cut a row,
not the column.

# Design findings — `nuggbudz-hackathon.2`

## Resolved from `.1`

| `.1` finding | Status |
| --- | --- |
| blocker — ask-slide URL illegible | Resolved; verified in the re-rendered PDF |
| major — empty header cells on slides 7 and 11 | Resolved |
| minor — clients and pools share one fill | Resolved |
| minor — in-bar chart labels too small | Resolved (14pt, shortened) |
| nit — slide 10 heading was a label | Resolved |

## nit — slide 12's supporting line wraps to two lines

"Gross of processing, support and fraud. $5.00 saved per pairing: the spread
splits 83% buyer / 17% platform." wraps. On a table slide with this much
whitespace it reads fine, and the clause it adds is the one the economics critic
asked for, so the wrap is the right trade. Recorded so it is a decision rather
than an oversight.

## Gap — no `deck-vision` pass

Vision dims v1–v6 are unscored. This critic reviewed the rendered pages
directly, which covers the same class of rendered-only defects at this deck's
size, but a VLM pass was not run and the gap is carried in `_revision-log.md`.

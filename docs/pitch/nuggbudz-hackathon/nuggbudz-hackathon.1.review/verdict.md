# Verdict — `nuggbudz-hackathon.1`

**Total**: 36 / 49 (threshold 43)
**Critical flags**: none
**advance**: false — revise into `nuggbudz-hackathon.2`

## Decision

A strong first draft with one rendered blocker and a cluster of fixable
majors. Nothing here is a foundational problem: the argument works, the
arithmetic is independently reproducible, and no claim is unattested. The
revision list is mechanical.

Two dimensions will not move much no matter how many passes we run, and the
operator should decide about them deliberately rather than iterating into them:

- **Dim 3, market size credibility (2/5)** — the deck declines to size the
  market because no input in this repository supports a sizing case, and an
  invented top-down number would trip a critical flag. This is the correct call
  for a hackathon audience and it costs ~3 points against a rubric calibrated
  for a fundraising deck.
- **Dim 6, team credibility (2/4)** — one attested claim exists (sole
  authorship). Padding it would be fabrication.

Together those two cap the achievable total near 43 even with everything else
perfect. That is a property of scoring a hackathon pitch against a fundraising
rubric, not a defect to fix in the deck.

## Blocking for the next revision

1. **[design, blocker]** Slide 13: the ask slide's URL renders illegibly (code
   span on the dark `_class: ask` field). Drop the backticks.
2. **[design, major]** Slides 7 and 11: empty leading header cells render as a
   blank grey band. Give both tables real headers.
3. **[narrative, major]** Slide 13: separate the judge-facing ask from the pilot
   ask and the milestone; lead with the one a judge can act on in the room.
4. **[economics, major]** Slide 12: state on the slide that the fee is gross of
   processing, support and fraud. Do not guess a processing rate.

## Recommended, non-blocking

5. **[market, minor]** Name DoorDash and Uber Eats on the competition slide
   (already attested in `BRIEF.md`); add one moat clause.
6. **[design, minor]** Re-colour the phones in the architecture figure so the
   clients and the per-cell market objects are visually distinct.
7. **[design, minor]** Raise the in-bar label size on the per-nugget chart.
8. **[narrative/design, nit]** Make the slide-10 heading carry its claim.
9. **[review, minor]** Put the "no users yet" admission on a slide, not only in
   the notes.

## Not to be "fixed"

- Do not add a TAM slide.
- Do not add a team slide with a padded bio.
- Do not net out an invented processing rate to make the take look like
  contribution.

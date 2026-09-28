# Aggregated scorecard — `nuggbudz-hackathon.1`

Per-dimension aggregate is the mean of non-null critic scores, rounded to the
nearest integer (`anvil/lib/snippets/critics.md` §Aggregation). Five critics
ran: `review`, `narrative`, `market`, `design`, `economics`.

| # | Dimension | Weight | Contributions | Aggregate | Justification |
| --- | --- | ---: | --- | ---: | --- |
| 1 | Narrative arc | 6 | narrative 5 | **5** | Spine holds end to end; flat spot at slide 10 |
| 2 | Problem clarity | 5 | review 5 | **5** | Understood cold in <30s, quantified, not solution-shaped |
| 3 | Market size credibility | 5 | market 2 | **2** | No sizing by design; unit arithmetic is all there is to score |
| 4 | Solution differentiation | 5 | market 4 | **4** | Mechanism-level differentiation; no moat clause on a slide |
| 5 | Traction / proof | 5 | review 4 | **4** | Deployed + verified against production; all proof builder-side |
| 6 | Team credibility | 4 | review 2 | **2** | One attested claim; team slide cut with rationale |
| 7 | Ask specificity | 5 | narrative 4 | **4** | Specific and correctly scoped; three asks compressed into one line |
| 8 | Design polish | 5 | design 3 | **3** | Lint-clean and dense-enough, but one unreadable slide element |
| 9 | Rhetorical economy | 4 | narrative 4 | **4** | 14 slides, no padding, cuts documented |
| 10 | Business-model credibility | 5 | economics 3 | **3** | Mechanic exact; no cost line on any slide |
| | **Total** | **49** | | **36** | Threshold to advance: 43 |

Vision-rubric dimensions (v1–v6): not scored — no `deck-vision` pass was run.
The design critic reviewed the rendered PDF directly, which covers the same
rendered-only defects for this deck's purposes but is recorded here as a gap.

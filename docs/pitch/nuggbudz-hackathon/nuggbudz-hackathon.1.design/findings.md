# Design findings — `nuggbudz-hackathon.1`

Severity scale: blocker / major / minor / nit. Slide numbers are rendered PDF
pages.

## blocker — slide 13 (ask): the contact URL is unreadable

`_class: ask` paints a deep navy background and sets body text white. The URL is
written as an inline code span, so it renders as near-white monospace on the
theme's pale code chip: the glyphs disappear into the chip and the chip fights
the navy field. This is the last thing on screen while the room is deciding.

**Fix**: drop the backticks on the ask slide and set the URL as plain italic
text alongside the name. Keep code formatting for file paths on light slides.

## major — slides 7 and 11: leading column has an empty header cell

Both tables open with a `| |` header, which Marp renders as a grey band with a
blank cell above the row labels. It reads as a missing header rather than a
deliberate label column.

**Fix**: give both tables real headers (`Line` / `Amount` on the settlement
table; `Plan` / `What happens` on the demo table).

## minor — slide 9 figure: clients and markets share one fill

`Phone A/B/C` and the two `NuggPool` nodes are both navy, so the diagram's one
load-bearing distinction — buyers on one side, the per-cell market object on the
other — is carried only by position. The Worker, the least interesting box, is
the only one that stands out.

**Fix**: render the phones in white with a muted stroke; keep navy for the
`NuggPool` nodes so the eye lands on the objects the slide is about.

## minor — slide 3 chart: in-bar labels sit below comfortable projection size

The rotated basket labels inside each bar render around 11pt at slide scale.
Legible on a laptop, marginal from the back of a room.

**Fix**: raise the in-bar label size and shorten the strings (the item name
already appears in the axis and the legend).

## nit — slide 10 heading is a label, not a claim

"It is shipped" names the topic; every other heading in the deck asserts
something. The slide's actual claim is that it is deployed *and independently
verified against production*.

## Positives worth preserving

- 0 errors / 0 warnings from the deterministic `slide-content-overflow` lint.
- Figure + single italic supporting line on both figure slides — the lint-safe
  idiom, inside the 18-word / 108-character budget.
- Consistent navy-on-white palette; the chart matches the theme because it
  imports `anvil.lib.figures.palette` rather than hard-coding hexes.

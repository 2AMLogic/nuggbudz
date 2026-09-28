# Revision log — `nuggbudz-hackathon.2` → `.3`

`.2` was a good argument wearing anvil's stock neutral fundraising theme, with
two Mermaid diagrams and no other imagery. Meanwhile the product had grown a
strong identity — 1996 workstation graphics, flat-shaded facets, a banded
indigo→magenta sky, an untinted checkerboard, chrome display type and
phosphor-green readouts. A deck that does not carry it reads as a different
product.

**No claim, figure or slide argument moved in this revision.** `.2`'s critic
verdict still describes this artifact; what changed is the theme, the imagery,
and two slides' wording where the new geometry demanded it.

## What changed

| # | Change | Why |
| --- | --- | --- |
| 1 | `theme: anvil-deck` → `theme: nuggbudz` | A consumer override at `.anvil/skills/deck/templates/nuggbudz.css`, ported from anvil's `brand-theme-starter.css` per `brand-theme-porting.md`. Every colour is lifted verbatim from the app's own tokens in `src/styles/globals.css`, so the deck and the running product cannot drift without both being edited. |
| 2 | Six generative images, on the title, two new dividers, the protocol slide, the market slide and the ask | `deck-imagegen` dispatching through the `imagine` CLI, one `<!-- anvil-imagegen: … -->` marker per slot, prompts in `speaker-notes.md`. |
| 3 | Two new section dividers (slides 2 and 6) | The deck had none. `.2` went from the money half to the system half with no pivot; slide 6 is that pivot and slide 2 states the premise everything else is arithmetic on. |
| 4 | Both figures redrawn in the brand palette, on transparent grounds | A chart and a diagram authored for a white slide are white holes punched in a dark one. `figures/src/per-nugget.py` now carries the app's hexes directly; `figures/src/mermaid-theme.json` is this thread's own mermaid theme. The chart's **data** is unchanged and still generated — `per-nugget.csv` is `renderPerPieceCsv()` byte for byte, and `test/deck.test.ts` still asserts it. |
| 5 | A `footer:` strip and per-slide pagination | The porting recipe's fourth theme slot; also where the deck now names itself on every slide. |
| 6 | Slide 12's last bullet shortened; slide 11's caption shortened | Not taste — see "The capacity trap" below. |

## The imagery, and what was cut

Eight slots were prompted, generated and looked at. Six shipped.

| Slot | Slide | Kept? |
| --- | --- | --- |
| `title-counter` | 1, title | Kept — a faceted nugget on a checkerboard mat on a real steel pass |
| `divider-spread` | 2, divider | Kept — a car-park-sized nugget on real wet tarmac at dusk |
| `divider-protocol` | 6, divider | Kept — two real phones on a real table, one hard green line between them |
| `protocol-pavement` | 7, protocol | Kept — two checkerboard squares on a real pavement, one green line |
| `market-counter` | 8, market | Kept — five identical boxes, each too big for one person, on a real counter |
| `ask-bench` | 15, ask | Kept — the handoff: a plain bag on a real bench, a nugget hovering over it |
| `deployed-edge` | 12 | **Cut** — a globe says *global*, a scale claim this deck deliberately does not make. It would have put a claim in a picture that the words refuse to make. |
| `demo-phones` | 13 | **Cut** — the best-looking of the eight, and redundant twice over: slide 6 already carries two phones and a green line, and slide 13's whole promise is that two *real* phones are about to pair in the room. |

Three of the six kept slots were re-rolled once. The failure mode both times was
the model inserting a rectangular "panel" or backdrop flat and pasting the
render into it, which breaks the composite — the synthetic object has to sit
*on* the real surface, not inside a floating frame. Naming that exclusion in the
slide prompt fixed it. The prompts as shipped are in `speaker-notes.md`.

**A composite has to survive the crop that ships, not the frame it was judged
in.** `protocol-pavement` was re-rolled a second time, in review. The first
render passed a full-frame look — pavement left and right, synthetic strip down
the middle — but slide 7 shows it as `![bg right:N%]`, and Marp crops a
background panel from the *centre* of the source. The panel that shipped was the
synthetic strip alone: no photographic content in it at all, which is a pure
render, which is off-brand by this deck's own test. The re-roll carries the same
"no panel, no backdrop flat, no coloured band" exclusion the other slots use and
asks for bare concrete on all four sides of the pair, and the split was widened
so the ground is in the panel rather than only in the PNG. Every one of the six
was then checked as-cropped at its shipped split, not full-frame; the other five
keep their plate.

**The constraint that governed all of it**: no generated image may be presented
as a real merchant's product, restaurant, customer or employee. Every plate is a
generic counter, car park, pavement, table or bench with no signage and no trade
dress; every slide carrying one says "concept render" on the slide; there are no
generated images of people. The stylised register is what makes that safe rather
than merely asserted — a faceted polygon nugget under a banded sky cannot be
mistaken for a product photograph.

## The capacity trap, and why two slides were reworded

The `slide-content-overflow` pre-flight lint is calibrated against the **shipped
anvil-deck theme's** padding, font size and line height. This theme spends 8px
more padding top and bottom, so a lint left at its defaults would have kept
reporting — about geometry that is not this deck's. That is a check that cannot
fail for the thing it names.

`nuggbudz.css` therefore declares its own `/* @anvil-capacity */` block:
`top_padding_px: 64`, `bottom_padding_px: 64`, `capacity_units: 12.6` (the
shipped 13.0 less the 16px of safe area the extra padding costs). Body metrics
are deliberately unchanged from the shipped theme — 26px at 1.45 — so
`body_line_height_px` is not restated; `_class: ask` padding is 88px against
this theme's 64px base, the same per-side delta the shipped theme's 80-against-56
has, so the ask penalty keeps its shipped value and is not restated either.

Run against that declared geometry, the lint found slide 12 over budget by 0.1
line units. The fix was the slide, not the lint: the last bullet was tightened
from three rendered lines to two. Slide 11's figure caption was shortened for
the same reason one step further on — the lint passed it, but the rendered PDF
showed the second line colliding with the new footer strip, which is exactly the
class of defect the vision pass exists to catch and the source lint cannot.

Slide 8 is the third instance, and it is why the attribution line went missing
there in the first place: adding it put the slide 0.3 units over. The fix is the
same trade, not the omission — the attribution line is non-negotiable, so the
slide's italic caption pays for it. It was two rendered lines and is now one,
which buys back more than the line costs. The rule that produced all three: when
a slide will not hold, the caption is what gives, never the attribution and never
the capacity declaration.

## What did not change

- Every money amount, percentage and ratio, and the slides they sit on.
  `test/deck.test.ts` audits `.3` now that it is the newest version dir, in both
  directions, and passes.
- The narrative spine from `nuggbudz-hackathon.0.outline/outline.md`.
- The deliberate omissions: no team slide, no financials, no market sizing.
- `refs/`, and the `.2` critic siblings, which are immutable.
- **No end-to-end check count anywhere.** Pinning one cost five PRs of churn and
  was removed in #49; nothing here reintroduces it in any form.

## Render lines

Imagery, from the repo root (it reads `.anvil/config.json`):

```bash
PYTHONPATH=.anvil python3 scripts/deck-imagegen.py nuggbudz-hackathon
```

Everything else, from this directory:

```bash
python3 figures/src/per-nugget.py

mmdc --input figures/src/architecture.mmd --output figures/architecture.png \
     -c figures/src/mermaid-theme.json --width 2200 --backgroundColor transparent

marp deck.md --pdf --html \
  --config-file ../../../../.anvil/anvil/lib/marp/config.yml \
  --theme-set ../../../../.anvil/skills/deck/templates/nuggbudz.css \
  --allow-local-files --no-stdin --output deck.pdf
```

`--theme-set` is load-bearing: `nuggbudz` is a consumer override and is not in
the pinned `themeSet`. So is `--no-stdin` — without it `marp` blocks forever
waiting on stdin when it is invoked from a script, which cost one debugging pass
here.

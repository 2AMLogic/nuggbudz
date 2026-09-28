# The pitch deck

An [Anvil](https://github.com/rjwalters/anvil) `deck` project. The presentable
artifact is the highest-numbered version directory:

```
docs/pitch/
  BRIEF.md                                   project brief (config locus)
  nuggbudz-hackathon/
    BRIEF.md                                 thread brief — the drafter's contract
    refs/                                    source-of-truth material
      economics-ledger.md                    generated ledger snapshot
      smoke-runs.md                          end-to-end run transcripts
    nuggbudz-hackathon.0.outline/            narrative spine (read-only once written)
    nuggbudz-hackathon.1/                    first draft (immutable)
    nuggbudz-hackathon.1.{review,narrative,market,design,economics}/
    nuggbudz-hackathon.2/                    superseded deck (immutable)
    nuggbudz-hackathon.2.{review,narrative,market,design,economics,audit}/
    nuggbudz-hackathon.3/                    current deck: deck.md, speaker-notes.md, deck.pdf
      assets/generated/                      generative imagery + one .json sidecar each
      assets/_prompts.json                   the prompt journal deck-imagegen writes
```

Start at `nuggbudz-hackathon.3/deck.pdf` for the slides,
`nuggbudz-hackathon.3/speaker-notes.md` for the talk track, the demo fallback
script and the imagery prompts, and `nuggbudz-hackathon.2.review/verdict.md` for
the honest assessment of where the argument is weak — `.3` changed the deck's
look, not its claims.

## Every generated image is a concept render, and says so

`.3` is the first version with generative imagery. Six images, all composites in
the same register: an obviously synthetic flat-shaded 1996-workstation render
sitting on an ordinary photographic plate. **None of them depicts a real
merchant's product, restaurant, staff or trade dress** — every plate is a
generic counter, car park, pavement, table or bench with no signage — and every
slide that carries one says "concept render" on the slide itself. There are no
generated photographs of people.

Each `assets/generated/<slot>.png` sits beside a `<slot>.png.json` sidecar
carrying the full prompt, the provider and model, the aspect ratio, and both the
provider's hash and the committed file's. **The pair is one artifact**: move
both, delete both. `assets/_prompts.json` is anvil's own journal of the same run
and is what makes a re-run free when nothing changed.

## Every figure is derived from the code

No money amount, percentage or ratio on a slide was typed by hand.
`scripts/deck-ledger.ts` derives them all from `shared/deals.ts` and
`shared/economics.ts` — the same catalogue and the same `settle()` /
`analyzeSpread()` the deployed Worker charges buyers with — and
`test/deck.test.ts` (so `pnpm test`, so CI) fails in **both** directions:

| Failure | Meaning |
| --- | --- |
| `… is not in the ledger` | A slide carries a figure the code does not produce — the code was repriced and the deck is stale, or a slide invented a number |
| `… missing a figure the code produces` | The code produces a figure the deck was carrying and no longer does |
| chart CSV mismatch | `figures/src/per-nugget.csv` no longer matches the catalogue, so the chart would be drawn from stale data |
| check-count literal missing | `scripts/smoke.mjs` gained or lost an assertion and the shipped slide still quotes the old count |

The failure message prints the whole ledger — key, literal, and the derivation
each one came from — so fixing a slide is a lookup, not an investigation.

Only the **newest** version directory is checked. Earlier version dirs and critic
siblings are immutable records and are allowed to hold the numbers that were true
when they were written.

### When the test fails

1. Read the ledger the failure prints, or regenerate the snapshot:
   `refs/economics-ledger.md` is `formatLedger(buildLedger())`.
2. Correct the slides in the **latest** version dir (never the ledger — it is
   derived).
3. If a chart's data changed, the CSV assertion tells you; re-render the figure.

This is not hypothetical maintenance. Google sign-in landed on `main` while this
deck was being drafted, `scripts/smoke.mjs` grew from 22 assertions to 32, and
the deck's own test failed on the stale count until the slide was corrected.

## Regenerating the artifacts

Generative imagery runs from the **repo root**, because it reads
`.anvil/config.json` and the adapter at `scripts/anvil_imagery_backend.py`:

```bash
# Generate every <!-- anvil-imagegen: <slot> --> slot in the latest deck.md, and
# write a .json sidecar beside each PNG. Idempotent: a slot whose prompt, style
# and steps are unchanged costs no backend call. Needs the `imagine` CLI on PATH
# and a provider credential — run `imagine doctor` first on any failure.
PYTHONPATH=.anvil python3 scripts/deck-imagegen.py nuggbudz-hackathon
```

Everything else runs from the version directory
(`docs/pitch/nuggbudz-hackathon/nuggbudz-hackathon.3`):

```bash
# Chart (matplotlib, NuggBudz palette, transparent so it sits on the dark slide).
# Data comes from the committed CSV, itself generated from shared/deals.ts by
# scripts/deck-ledger.ts.
python3 figures/src/per-nugget.py

# Architecture diagram (mermaid -> PNG; inline mermaid does NOT render in Marp
# PDF). The theme is this thread's own — anvil's shipped one is navy-on-white.
mmdc --input figures/src/architecture.mmd --output figures/architecture.png \
     -c figures/src/mermaid-theme.json --width 2200 --backgroundColor transparent

# Slides. --theme-set is load-bearing: `nuggbudz` is a consumer override and is
# not in the pinned themeSet. --no-stdin is load-bearing too — without it marp
# blocks forever waiting on stdin when it is invoked from a script.
marp deck.md --pdf --html \
  --config-file ../../../../.anvil/anvil/lib/marp/config.yml \
  --theme-set ../../../../.anvil/skills/deck/templates/nuggbudz.css \
  --allow-local-files --no-stdin --output deck.pdf

# Deterministic overflow pre-flight (what deck-review gates on). Pass the theme's
# own geometry: the lint's default budget is calibrated against the SHIPPED
# theme's padding, and a ported theme that does not declare its own
# @anvil-capacity block gets linted against numbers that are not its own.
PYTHONPATH=../../../../.anvil python3 -c \
  "from anvil.lib.marp_lint import lint_deck, geometry_from_theme_contract as g; \
   print(lint_deck('deck.md', geometry=g('../../../../.anvil/skills/deck/templates/nuggbudz.css').geometry).to_summary())"
```

A handout with the speaker notes below each slide needs `pdfjam`, which is not
installed on the authoring host; the PDF above is the shipped artifact.

## State of the thread

`REVISED` at `.3`. The scored review is `.2`'s — 40/49 with no critical flags,
deliberately **not** advanced to `READY` — and it still stands, because `.3`
changed the theme and the imagery and left every claim, figure and slide
argument where `.2` put them. The nine missing points are market sizing (3) and team credentials (2) —
which this artifact declines to fabricate — plus four points gated on evidence a
pilot would produce. `nuggbudz-hackathon.2.review/verdict.md` records the call
and what a fundraising version of the deck would need instead.

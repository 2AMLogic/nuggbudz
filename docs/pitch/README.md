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
    nuggbudz-hackathon.2/                    current deck: deck.md, speaker-notes.md, deck.pdf
    nuggbudz-hackathon.2.{review,narrative,market,design,economics,audit}/
```

Start at `nuggbudz-hackathon.2/deck.pdf` for the slides,
`nuggbudz-hackathon.2/speaker-notes.md` for the talk track and the demo fallback
script, and `nuggbudz-hackathon.2.review/verdict.md` for the honest assessment
of where it is weak.

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

From the version directory (`docs/pitch/nuggbudz-hackathon/nuggbudz-hackathon.2`):

```bash
# Chart (matplotlib, anvil palette). Data comes from the committed CSV, which is
# itself generated from shared/deals.ts by scripts/deck-ledger.ts.
uv run --project ../../../../.anvil --with matplotlib python figures/src/per-nugget.py

# Architecture diagram (mermaid -> PNG; inline mermaid does NOT render in Marp PDF)
mmdc --input figures/src/architecture.mmd --output figures/architecture.png \
     -c ../../../../.anvil/anvil/lib/figures/mermaid-theme.json \
     --width 1800 --height 1000 --backgroundColor white

# Slides
marp deck.md --pdf --html \
  --config-file ../../../../.anvil/anvil/lib/marp/config.yml \
  --theme-set ../../../../.anvil/skills/deck/assets/anvil-deck.css \
  --allow-local-files --no-stdin --output deck.pdf

# Deterministic overflow pre-flight (what deck-review gates on)
uv run --project ../../../../.anvil python -c \
  "from anvil.lib.marp_lint import lint_deck; print(lint_deck('deck.md').to_summary())"
```

A handout with the speaker notes below each slide needs `pdfjam`, which is not
installed on the authoring host; the PDF above is the shipped artifact.

## State of the thread

`REVISED` at `.2`, 40/49 with no critical flags, deliberately **not** advanced to
`READY`. The nine missing points are market sizing (3) and team credentials (2) —
which this artifact declines to fabricate — plus four points gated on evidence a
pilot would produce. `nuggbudz-hackathon.2.review/verdict.md` records the call
and what a fundraising version of the deck would need instead.

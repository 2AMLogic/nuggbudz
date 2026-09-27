---
project: nuggbudz-pitch
documents:
  - nuggbudz-hackathon
---

# NuggBudz — pitch project

Anvil project root for NuggBudz presentation artifacts. One thread today:

| Thread | Artifact | Audience |
| --- | --- | --- |
| `nuggbudz-hackathon` | `anvil:deck` pitch deck | Hackathon judges, 5-minute slot + live demo |

## The rule that governs every thread here

**No figure is typed by hand.** Every money amount, percentage and ratio on a
slide is derived in `scripts/deck-ledger.ts` from `shared/deals.ts` and
`shared/economics.ts` — the same catalogue and the same `settle()` /
`analyzeSpread()` the deployed Worker charges buyers with — and
`test/deck.test.ts` fails the build if a slide and the code disagree in either
direction:

- a slide quotes a money/percent/ratio literal the code does not produce, or
- the code produces a figure the deck was supposed to carry and no longer does.

So a price change in `shared/deals.ts` turns `pnpm test` red until the slides
are corrected. See `docs/pitch/README.md` for how to run it and how to fix a
failure.

## Shared research pool

None. Every claim in this project traces to code, to `README.md` / `CLAUDE.md`,
or to a command whose output is quoted in the thread's `refs/`.

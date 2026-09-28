---
critic: audit
critical_flag: false
rubric_id: anvil-deck-v3
---

# Audit — `nuggbudz-hackathon.2`

Fact/number/citation audit at READY-adjacent state. The auditor scores no rubric
dimension; it exists to raise a fabrication flag, and it did not.

| # | Dimension | Score | Weight |
| --- | --- | --- | --- |
| 1–10 | (all) | null | 49 |

**critical_flag: false.** No fabricated traction, no fabricated team
credential, no unattested logo or asset, no unattested competitor, no
unlabelled projection.

## What was checked, and with what

| Check | Tool | Result |
| --- | --- | --- |
| Every money / percentage / ratio on a slide traces to the catalogue | `npx vitest run test/deck.test.ts` | 5 passed — 32 distinct literals, all in the ledger |
| Every ledger figure marked `slide` appears in the deck | same test, second case | pass |
| Chart data matches the catalogue byte for byte | same test, third case | pass |
| The check count on slide 10 matches the smoke source | same test, `countSmokeChecks()` | pass (32) |
| Slide overflow | `anvil.lib.marp_lint.lint_deck` | 0 errors, 0 warnings, 0 infos |
| The 32/32 run actually passed | `pnpm dev --port 5199` + `pnpm smoke` | ALL CHECKS PASSED, transcript in `refs/smoke-runs.md` |
| The deployment is live and is the pre-sign-in build | `curl /api/health` -> `protocol: 1`; `curl /api/auth/me` -> 404 | as claimed on the slide and in the notes |
| Authorship claim | `git log --format='%an' \| sort \| uniq -c` | single author, as claimed |
| Architecture claims | read `worker/pool.ts`, `worker/index.ts`, `shared/matchmaker.ts`, `shared/geo.ts` at `05b9799` | all four claims hold |
| Cell names and distances in the figure | computed with the repo's own `geohash()` / `distanceMeters()` | `9q8znb`, `9q8yyk`, 210 m, 3.2 km — reproduced |

## Claims deliberately *not* made (verified absent)

- No TAM / SAM / SOM figure anywhere in the deck or notes.
- No user count, revenue figure, LOI, pilot or design partner.
- No founder bio beyond authorship; no advisor; no logo.
- No forward-looking number presented as current: the volume table is labelled
  arithmetic on the fee, and the speaker notes repeat the label.

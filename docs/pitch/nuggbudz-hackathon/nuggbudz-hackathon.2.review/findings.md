# General-reviewer findings — `nuggbudz-hackathon.2`

## Lint findings

`slide-content-overflow`: **0 errors, 0 warnings**. Auto-shrink detector and
text-layer-completeness gate: skipped (optional extras not installed); recorded
as info, not a gate.

## Resolved from `.1`

| `.1` finding | Status |
| --- | --- |
| minor — team claim folded into the traction list | Accepted as-is; the heading now carries the verification claim so the authorship line reads as the aside it is |
| minor — "no users" admission only in the notes | Resolved; on the slide, in bold |

## minor — the deployed build and `main` have diverged

Slide 10 claims a deployment and a 32-check run that were produced by different
commits. Both statements are true and the notes explain the split, but a judge
who opens the URL is on the pre-sign-in build. This is a deploy task, not a deck
task.

**Recommendation**: redeploy before the slot if the OAuth client is configured;
otherwise keep Plan A exactly as written, since the older build is the one that
lets a stranger pair without an account.

## Verified, no action

- Every money figure, percentage and ratio on every slide traces to
  `shared/deals.ts` / `shared/economics.ts` through `scripts/deck-ledger.ts`;
  `test/deck.test.ts` enforces it in both directions and passes at this
  revision (5 tests, part of the 91-test suite).
- No fabricated traction, no fabricated team credential, no unattested logo, no
  generative imagery (`imagery_policy: deterministic-only`, honoured).
- Architecture claims re-checked against the **post-rebase** sources
  (`worker/pool.ts`, `worker/index.ts`, `shared/matchmaker.ts`): one Durable
  Object per geohash cell; the cell and now the identity both resolved
  server-side before the upgrade; one event at a time with no lock in the
  pairing path; hibernation attachment for per-connection state;
  first-come-first-served on the waiting side. All hold.

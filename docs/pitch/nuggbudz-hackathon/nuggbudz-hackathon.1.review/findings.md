# General-reviewer findings — `nuggbudz-hackathon.1`

## Lint findings

`slide-content-overflow` (deterministic pre-flight): **0 errors, 0 warnings**.
Auto-shrink detector and text-layer-completeness gate: skipped (optional Pillow
/ numpy extra not installed in this environment); recorded as info, not a gate.

## minor — slide 10 mixes a team claim into a traction list

"Built solo, in the hackathon window, by Robb Walters (2AM Logic)" is a team
credential sitting in the traction bullets. Given the team slide was cut
deliberately, this is the right place for it, but it should read as the
deliberate fold it is rather than as a fourth piece of traction.

**Fix**: keep it, and let the heading carry the verification claim so the
authorship line reads as a closing aside.

## minor — the "no users" admission is in the notes, not on a slide

The deck is admirably honest in the speaker notes ("No users, no revenue — say
so before anyone asks") but a judge reading the PDF afterwards sees only
positive proof. Decks get forwarded without their notes.

**Fix**: one clause on the shipped slide naming what is not yet proven. It costs
nothing with this audience and it is the difference between honest and
honest-when-asked.

## Verified, no action

- Every figure on every slide traces to `shared/deals.ts` / `shared/economics.ts`
  through `scripts/deck-ledger.ts`; `test/deck.test.ts` enforces it in both
  directions and passes at this revision.
- No fabricated traction, no fabricated team credential, no unattested logo, no
  generative imagery (`imagery_policy: deterministic-only`, honoured — both
  images are rendered from committed sources in `figures/src/`).
- The architecture slide's claims were checked against `worker/pool.ts`,
  `worker/index.ts` and `shared/matchmaker.ts` rather than against `README.md`:
  one DO per geohash cell, cell derived server-side, single-threaded event
  handling with no lock in the pairing path, hibernation attachment for
  per-connection state. All four hold.

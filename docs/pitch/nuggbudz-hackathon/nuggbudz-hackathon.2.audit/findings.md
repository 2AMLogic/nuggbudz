# Audit findings — `nuggbudz-hackathon.2`

## No fabrication findings

Every number on a slide is generated from `shared/deals.ts` /
`shared/economics.ts` or counted from `scripts/smoke.mjs`; the audit's usual
hardest question — "where did this number come from?" — is answered by a test
rather than by a spreadsheet nobody can find.

## info — the audit's own strongest evidence is reproducible by the reader

`pnpm test` is the whole number-provenance audit. A reviewer does not have to
trust this sibling: they can change a price in `shared/deals.ts`, watch the
suite go red, and read the ledger the failure prints.

Demonstrated during this audit by temporarily setting the McNuggets 20pc price
to a different value: `test/deck.test.ts` failed three cases — the stale
literals on the slides became orphans, the new derived literals became missing,
and the committed chart CSV stopped matching the catalogue. Reverted
immediately; the suite is green at this revision.

## info — two claims depend on a deployment that may change

Slide 10's deployment claim and the notes' "the deployed build predates
sign-in" are true as of this audit and will stop being true after the next
`pnpm run deploy`. Neither is a fabrication risk; both are recorded here so the
presenter re-checks `/api/health` before the slot.

## info — `refs/economics-ledger.md` is a snapshot

It is regenerated output stamped with the commit it was generated from. It
carries every ledger literal, so the drift test scans it as live prose and would
fail if it went stale against the catalogue. It is substrate for a human, not
the enforcement mechanism.

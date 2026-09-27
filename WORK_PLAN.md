# Work Plan

Prioritized roadmap of upcoming work, maintained by the Guide role.

<!-- Maintained automatically by the Guide triage agent. Manual edits are fine but may be overwritten. -->

## Urgent

Issues requiring immediate attention (`loom:urgent`).

- **#2**: Google OAuth sign-in — pairing is between anonymous sockets until this
  lands, which blocks reputation, refunds and any real accountability.
- **#3**: Charge both halves through Stripe and take the pairing fee — the
  settlement is computed and displayed but no money moves.

## Ready

Human-approved issues ready for implementation (`loom:issue`).

- **#4**: Write settled splits to the D1 ledger
- **#5**: Two-sided pickup confirmation handshake
- **#6**: Map view of your cell
- **#7**: Expire stale queue entries and unconfirmed matches
- **#9**: Playwright two-browser pairing test
- **#10**: Rate-limit the pool socket
- **#11**: Pitch deck built with Anvil

## In Progress

Issues actively being worked (`loom:building`).

*No issues currently being built.*

## Proposed

Issues under evaluation (`loom:architect`, `loom:hermit`, `loom:curated`).

- **#8**: Buddy reputation and no-show tracking — held until #2 (stable
  identities) and #5 (a completion signal) land, since it is meaningless
  without both.

## Epics

Active epics with progress tracking.

*No active epics.*

## Dependency notes

- #8 depends on #2 and #5.
- #4 is most useful after #5, since a confirmed pickup is what should trigger
  the ledger write.
- #3 should land after or alongside #2; charging a party requires knowing who
  the party is.

## Backlog Balance

| Tier | Count |
|------|-------|
| Tier 1 (goal-advancing) | 4 |
| Tier 2 (goal-supporting) | 5 |
| Tier 3 (maintenance) | 1 |

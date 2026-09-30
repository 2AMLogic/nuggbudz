# Work Plan

Prioritized roadmap of upcoming work, maintained by the Guide role.

<!-- Maintained automatically by the Guide triage agent. Manual edits are fine but may be overwritten. -->

## Urgent

Issues requiring immediate attention (`loom:urgent`).

- **#126**: Restore the photoreal half of the brand — composite the render over
  photographic plates.

> #3 (Stripe charging) shipped in PR #19; #8 (buddy reputation) and the holds
> queue landed after it. #2 (Google sign-in) merged `05b9799`; #28
> (McDonald's-only) merged `e22229b`; #16, #5, #4, #6, #7's predecessor work,
> #9 and #10 all landed. See WORK_LOG.md.

## Ready

Human-approved issues ready for implementation (`loom:issue`).

*#126 (photoreal brand) and #37 (wrangler `dev --var` bug) carry `loom:issue`.
Both are also `loom:operator-only`, so neither is agent-buildable.*

Curated and waiting for approval (`loom:curated`, no `loom:issue`):

- **#148**: The orderer is sent to the counter with no way to place the order.
- **#160**: A requeued buyer is never re-matched until somebody else joins, and
  honeypots make that the common case.

> The earlier "waiting on triage" list has cleared: #147 (store locations),
> #149 (payment information), #150 (late sign-in), #151 (honeypot buyers),
> #48 (`sanitizeDemoName`) and #14 (pairing nonce) closed as completed, and
> #36 (custom domain) closed because the domain was already live. Codifying
> it in the repo is #78.

## In Progress

Issues actively being worked (`loom:building`; PRs in `loom:reviewing` count as
in flight).

*None. No feature PR is open; #3 (PR #19), #7 (PR #23) and #34 (PR #43) all
merged.*

## Operator-held

Open issues that need the operator (`loom:operator-only` or
`loom:needs-capability`):

- **#78**: Codify the `nuggbudz.com` custom domain in `wrangler.jsonc` and fix
  the stale README deploy docs (operator decision).
- **#66**: Move the basemap off `tile.openstreetmap.org` before nuggbudz.com is
  a product (operator decision).
- **#125**: No brand surfaces (favicon, OG image, theme-color); blocked on a
  capability.

## Unlabelled backlog

Filed but not yet curated: #135 (D1 schema drift detection), #107 (demo
hostname in the deck), #106 and #105 (the socket-upgrade limit), #96 and #95
(smoke/test observability), #94 and #93 (naming cleanups), #67 (OAuth route
test), #57 (gating the merge result), #56 and #54 (smoke failures).

## Epics

Active epics with progress tracking.

*No active epics.*

## Backlog Balance

Open issues by tier label, excluding the #113 champion digest:

| Tier | Count |
|------|-------|
| Tier 1 (goal-advancing) | 2 (#126, #105) |
| Tier 2 (goal-supporting) | 3 (#125, #78, #37) |
| Tier 3 (maintenance) | 0 |
| No tier label | 14 |

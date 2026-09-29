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
Operator-filed items waiting on triage/curator: #147 (store locations on the
map), #148 (the orderer's order link), #149 (production takes no payment
information), #150 (late sign-in, one bypass in one place), #151 (honeypot
buyers), plus #36 (custom domain), #48 (`sanitizeDemoName` hardening) and #14
(pairing-flow nonce).*

## In Progress

Issues actively being worked (`loom:building`; PRs in `loom:reviewing` count as
in flight).

- **#3**: Stripe checkout handoff — PR #19, `loom:changes-requested`
  (doctor loop; lease on #11 lapsed 2026-09-27 ~21:27Z).
- **#7**: Stale queue expiry + unconfirmed-match alarm — PR #23, reconciled
  onto post-#22 main by the fleet, `loom:review-requested`, CI green on
  feature/issue-7 (`36360488913`); review pending.
- **#34**: Pair without a location permission prompt (edge geo) — PR #43,
  `loom:review-requested`, CI green on feature/issue-34 (`36360308132`); the
  reconciliation absorbed the #49 unpinned deck and re-priced — review pending.
- **#28**: (merged `e22229b` this session — offered-deal gate, see WORK_LOG)
- **#16**: (merged `5050eaf` this session — demo pairing with the ledger
  gate, see WORK_LOG)

## Newly filed (this session)

- **#36**: Provision the `nuggbudz.com` custom domain on the Worker (needs
  operator zone access; wrangler.jsonc was deliberately stripped of the routes
  until then — #24 decision).
- **#37**: Wrangler 4.142 `dev --var` does not reach the runtime (`undefined`) —
  reproducible; `.dev.vars` and (presumably) `deploy --var` are unaffected;
  upstream report to file.
- **#48**: Harden `sanitizeDemoName` — invisible-unicode strip + code-point-
safe cap (operator's superseded Doctor fix on #24 contains the working
  regexes; see that PR's comments).
- **#14**: Single-use nonce on the pairing flow (curator target once it has
  traffic context).

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

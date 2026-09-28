# Work Log

Chronological record of completed work in this repository, maintained by the Guide role.

Entries are grouped by date, newest first. Each entry references the merged PR or closed issue.

<!-- Maintained automatically by the Guide triage agent. Manual edits are fine but may be overwritten. -->

### 2026-09-27

- **Merge of the morning's queue by the operator** (attended judge/
  champion/driver session)
  - Merged **#31** (deck 32/32 → 57/57 drift fix; fleet PR, operator gate +
    merge) — `a70b0ea`; main green again.
  - Merged **#32** (bounded D1 retry with injectable sleep — the backoff
    #22's rebase had silently dropped) — fleet, `662317f`.
  - Merged **#24** / closed **#16** (demo pairing) — `5050eaf`. Operator
    judged the first head, caught the blocking defect a completed demo pair
    still booking real D1 ledger rows, and verified the Doctor's fix at the
    wire (demo handshake to `purchase_complete` with the ledger row count
    unchanged) before `loom:pr`. The alternative operator Doctor fix was
    abandoned as a deliberate duplicate: the fleet's guard sits inside
    `worker/ledger.ts` (single choke point) rather than at the call site.
  - Merged **#49** / closed **#46** (fleet): the deck no longer pins a smoke
    check **count** — it says "every end-to-end check passes" and the deck
    test forbids an `N/N` literal beside it. Ends the reprice whack-a-mole
    (#26, #28, #31 were all the same class of conflict).
  - Merged **#30** / closed **#28** (McDonald's-only catalog) — `e22229b`.
    Offered-vs-exists split (`findDeal` vs `isDealOffered`) gated on both the
    quote route and the **pairing path** (a hand-rolled `join` naming a gated
    chain is refused `unknown_deal` and never queued); cross-deal smoke
    scenarios re-anchored by cell; deck reconciled to #49's unpinned wording
    and the 66-check merged run recorded as Run 3 in the runs ledger.
- **Filed** #48 (`sanitizeDemoName`: invisible-unicode strip + code-point-safe
cap; working regexes preserved in the operator's superseded Doctor commit
  `d911bd7` on issue #16), #36 (provision `nuggbudz.com` — wrangler.jsonc was
deliberately stripped of the routes in #24 until the zone exists), #37
(Wrangler 4.142 `dev --var` reaches the runtime as `undefined`; `.dev.vars`
works; upstream report to file).
- **In flight at session end**: #23 (stale queue expiry) and #43 (promptless
  edge-geo pairing) both reconciled by the fleet onto post-#30 main, CI green,
`loom:review-requested`; #19 (Stripe) in the doctor loop with the last lease on
issue #11 lapsed — next sweep should re-claim.
- Precedent note (operator): on this repo `gh pr comment --body @file` posts the
  *literal path*; use `--body @- < file`. And a merge with `loom:pr` plus
`loom:review-requested` still attached is blocked by design (mutual exclusion)
— remove the review label on the way to `loom:pr`, or don't apply it.
- **Backlog fan-out started** — all nine seeded issues (#2–#7, #9–#11) claimed
  and under active `loom:building` sweeps across three loom hosts (lease
  records on each issue); #8 held in `loom:curated` pending #2 + #5.
  Completion tracked by durable daemon watches from the operator machine.
- **M0 shipped: live pairing engine** (`e140ba0`)
  - `NuggPool` Durable Object, one instance per geohash precision-6 cell, with
    hibernatable WebSockets and connection state in socket attachments.
  - Settlement math in integer cents, remainders to the orderer; 36 unit tests.
  - `scripts/smoke.mjs` drives two real WebSocket clients through pairing, role
    assignment, abandonment and requeue against the live Worker — 23 checks.
  - Two bugs caught and fixed before the first commit: a state spread that reset
    a matched buddy to `waiting`, and a requeued survivor receiving no refreshed
    pool count.
- **Loom orchestration installed** (#1) — Loom 0.19.461, 35 labels synced.
- **Repo and Anvil installed** (`f397234`) — repository hygiene skills and
  long-form artifact tooling, the latter for the pitch deck.
- **Backlog seeded** — 10 issues (#2–#11) covering auth, payments, the ledger,
  pickup confirmation, maps, expiry, reputation, e2e coverage, rate limiting and
  the pitch deck.
  - Project type: webapp (Cloudflare Worker + Durable Objects + D1)
  - Tech stack: Hono, React 19, Tailwind 4, Leaflet, Biome, Vitest
  - Visibility: public (2AMLogic org)

# NuggBudz — working notes for Claude

## What this is

A hyper-local pairing protocol: two people near each other split one 20-piece
nugget box, and both pay less than either would alone. The interesting part is
not the app, it is that the retail spread is real — a 20pc box costs less than a
10pc box in most markets — and the protocol just needs to find the second buyer
before either of them gives up and orders solo.

## Architecture in one paragraph

A single Cloudflare Worker (`worker/index.ts`, Hono) serves the API and the
built SPA. Live matching lives in a Durable Object, `NuggPool`, with **one
instance per geohash cell** — the cell is a *shard*, and the market is
`MATCH_RADIUS_METERS` (two miles) measured inside it. Durable Objects process one
event at a time, which is what makes "two buyers paired to the same third party"
impossible without any locking, and the shard is deliberately much wider
(precision 3, ~156 km) than the circle it has to contain so that one object stays
authoritative over every candidate it might pair. Per-connection state lives in
the WebSocket's hibernation attachment (`serializeAttachment`), not in instance
fields, so an idle shard can be evicted between rushes without losing the queue.
D1 is the durable ledger of settled splits; the Durable Object owns only live
state.

## Rules that matter

- **Money is integer cents, everywhere.** Never a float. `shared/economics.ts`
  is the only place that divides money, and `divideCents` guarantees the shares
  sum back to the total exactly. Indivisible remainders go to the orderer.
- **Deal prices are data, not literals.** They live in `shared/deals.ts` and
  vary by market and promo. Never inline `799` at a call site.
- **Sauces are data too, and the horoscope is derived.** `shared/sauces.ts` holds
  the ids, labels and per-sauce traits, per merchant, and which sauces are
  *offered* follows `ACTIVE_DEALS` rather than a second list. Never inline a sauce
  id or label at a call site. The readout is a pure function of the chosen pair —
  no randomness, no clock, no fetch — and `test/sauces.test.ts` enumerates the
  whole selection space from the catalogue, so adding a sauce fails the build
  rather than printing a blank card.
- **`shared/` must stay runtime-free.** No Workers types, no DOM, no React. It
  is imported by the Worker, the Durable Object, the client and the tests, and
  the pairing rule has to be testable without a Workers runtime.
- **Anything off a WebSocket is hostile.** Validate through
  `parseClientMessage` rather than casting.
- **Deck figures are derived, never typed.** Every money amount on a slide in
  `docs/pitch/` comes from `scripts/deck-ledger.ts`, which reads the catalogue
  and the settlement functions. Reprice a deal and `pnpm test` goes red until
  the slides are corrected — fix the slides, never the ledger.
- **The server derives the cell, never the client.** Otherwise a caller parks
  themselves in someone else's shard. It also derives the *coordinates* by
  default: `shared/location.ts` resolves client-supplied coords (opt-in only) →
  Cloudflare edge geo (`request.cf`) → a fixed demo origin, so pairing never
  needs a location prompt. `cf` is untrusted and can be missing or partial —
  parse it through `parseCoords`, never straight into `geohash()`. Miniflare
  caches a real `cf` locally, so `pnpm dev` usually gets rung 2; with no usable
  one (offline, or unit tests) rung 3 keeps the flow alive. The buyer is told the
  position the server used and which rung produced it, because the map needs a
  centre on every rung and a buyer on the demo origin must never be told it is
  where they are.
- **The radius is the market; the cell is a shard, and no user ever sees it.**
  `MATCH_RADIUS_METERS` decides who may pair, and it also scopes every count and
  roster the pool broadcasts — `waiting`, `queuedAhead` and `buddies` are all
  filtered to the recipient's circle, never to the shard, which is a region.
  Distances are **metres everywhere in code**, the same way money is cents:
  `shared/geo.ts` holds the one conversion (`METERS_PER_MILE`) and the only two
  formatters (`formatDistance`, `formatMiles`), the figure reaches the client over
  the protocol in `welcome`, and `3219` appears exactly once, in `wrangler.jsonc`.
  Coarsening the shard is the safe direction to change this; fanning out to
  neighbour cells is not, because it gives up the single-object invariant above.
- **Test fixtures are isolated by distance, not by cell.** Every live-pairing
  coordinate in the repo lives in `scripts/pool-fixtures.mjs` — smoke, e2e and the
  payment-gate lane share one table — and each scenario owns a *market*, one metro
  area, at least 100 km from every other and from `DEMO_ORIGIN` (where every
  promptless socket lands). `test/fixture-separation.test.ts` derives that from
  the table and the repo's own `distanceMeters`, because two scenarios inside each
  other's radius fail as a race rather than as a broken test. Never add a fixture
  coordinate at a call site.
- **Identity comes from the session, never from a message.** The pool socket is
  authenticated at upgrade time and the display name a buddy sees is read off
  the session in KV. A `name` on the wire is ignored, not trusted.
- **Nuggchat is relayed and never stored.** A message between matched buddies is
  handed to the other socket or refused — nothing reaches D1, Durable Object
  storage or KV, and there is no history to fetch on reconnect. That is a
  constraint, not an omission: it keeps conversation out of a ledger that only
  accepts authentic settlements, it keeps us out of a moderation surface nobody
  can staff, and it is what makes the promise on screen true. `pnpm smoke`
  proves it by scanning every D1 table and every byte under `.wrangler/state`
  for text that was just exchanged, with a positive control so the scan cannot
  pass by looking in the wrong place. If something must be stored, raise it.
- **One sanitizer for untrusted display text.** `sanitizeDisplayText` in
  `shared/text.ts` is it — a demo display name and a chat message are the same
  threat. Whitespace is normalised *before* control characters are stripped, so
  a newline separates words instead of gluing them. Add rules there, never in a
  second copy.
- **A split settles only when both sides confirm the handoff.** The orderer
  holds a random pickup code (never derived from the match id, and never sent
  to the receiver); the receiver reads it off them. One side confirming alone
  times out into a dispute, and completing the handshake is the only thing that
  writes a row to the D1 ledger.
- **Money clears before the handshake starts, and the gate fails closed.**
  `paymentDisposition` in `worker/lib/payments.ts` decides once per match
  whether it is charged, is a demo pair, is deliberately uncharged, or cannot
  happen at all — and that one value gates both the pickup code and
  `confirm_pickup`, so a half-paid match reaches neither a code nor a ledger
  row. A pool with no Stripe secrets and no explicit `ALLOW_UNCHARGED_PAIRING`
  **refuses to pair**; it never pairs for free. Demo pairs never reach Stripe,
  because `demo` is answered before the secrets are consulted — enforced on the
  path, and proved by the `demo-check` CI job running with Stripe pointed at a
  dead address.
- **A dispute holds the money; every other teardown refunds it — and a refund is
  only a refund once Stripe says so.** `disputeMatch` deliberately does not
  refund: auto-refunding when one buddy confirms and the other goes silent would
  make silence the cheapest way to eat for free, which is the same reasoning that
  writes no ledger row. That hold is documented in `README.md` and stated on
  screen, because holding money you have no automated way to return is only
  defensible if it is written down. Everywhere else, `refund()` returns the legs
  Stripe *confirmed* and `markRefunded` stamps only those — never before the call.
  A leg whose refund failed stays `succeeded` (money collected, not returned) and
  the buyer is told `heldCents`, never `refunded`. A match being deleted leaves
  its unfinished money behind as a tombstone (`retireMatch`, the one place a
  `match:` key is removed), so a PaymentIntent that clears *after* its match died
  is still refunded rather than answered `unknown_match`.

## Reconciling a conflicted branch: merge `origin/main` in, do not rebase onto it

On PR #73 (issue #70), a Judge merged `origin/main` into a feature branch and,
while reconciling, found a hazard `git` never reports: that PR's chat
"buddy leaves" test fixtures and an unrelated, already-merged PR's sauce test
fixtures sat at byte-identical coordinates. Same coordinate → same geohash
cell → one `NuggPool` Durable Object, silently defeating the per-cell
isolation both files' own comments claim. The Judge moved one fixture and left
the fix in a merge commit. A later rebase of the *same branch* onto a newer
`main`, force-pushed as a single flattened commit, resolved that identical
conflict a second time — and got it wrong, putting the collision straight
back. Nothing caught it mechanically: it is not a conflict marker, not a type
error, not a lint finding, and not even a reliable `pnpm smoke` failure (two
scenarios sharing a cell is a *race*, not a deterministic break). The only
reason it never reached `main` was a Doctor that happened to have the branch's
expected parent SHA on hand and noticed the tip was wrong (see issue #80).

The lesson generalizes past this one fixture: a rebase re-decides *every*
prior conflict resolution on the branch from scratch, replaying commits
against a new base with no memory of how a human or a Judge resolved the same
hunk before. A merge, by contrast, only asks git to reconcile what has moved
since the last reconciliation, and leaves the prior resolution's commit intact
in history — nothing "shows the diff" of the stakes of getting it wrong.
Concretely:

- **Prefer `git merge origin/main` over `git rebase origin/main` whenever
  resolving a conflicted branch that already contains resolved history** —
  in particular a branch that already carries a merge commit reconciling an
  earlier `main`. Squashing that history away and re-deciding its conflicts
  in one shot is exactly what went wrong on PR #73.
- **Whoever resolves a real (non-mechanical) conflict, or force-pushes over a
  branch's previous conflict resolution, must say so in a PR comment**: which
  side of the conflict was kept, and why. State it in enough specific detail
  (file, values kept) that the next agent can diff intent against the
  previous resolution rather than only diffing text. A rebase that silently
  reintroduces a fixed defect is invisible to `git diff` between two "correct
  looking" resolutions; a comment that says which one was kept is not.
- The mechanical backstop for this specific defect class —
  `test/fixture-separation.test.ts` — checks that every fixture in
  `scripts/pool-fixtures.mjs` is more than a hundred kilometres from every other
  scenario's, with each in-market exception declared and re-checked against the
  coordinates. It began (#80) as a check that every scenario had a geohash cell
  of its own; #82 made the cell a ~156 km shard, at which point cell
  distinctness stopped meaning isolation and distance became the unit. It exists
  so this hazard no longer depends on anyone reading coordinate literals, but it
  does not generalize to every conflict a rebase could re-litigate — the rule
  above is the general one.

## Commands

```bash
pnpm dev          # Vite + Worker together, full stack
pnpm test         # vitest — pure logic (settlement, geo, matchmaking, protocol)
pnpm smoke        # end-to-end pairing against a running `pnpm dev`
pnpm payment-gate # the money gate, in whichever mode that server reports
pnpm fake-stripe  # a local stand-in for Stripe's REST API, for the charged path
pnpm test:e2e     # Playwright — two browsers driving the real UI end to end
pnpm typecheck    # wrangler types && tsc --noEmit
pnpm lint         # biome
pnpm run deploy      # strict deploy — sign-in only (`pnpm deploy` is a pnpm builtin)
pnpm run deploy:demo # stage deploy — adds --var ALLOW_DEMO_PAIRING:1, see README "Demo pairing"
```

`pnpm test` does not cover the Durable Object. `pnpm smoke` does, and needs a
dev server on port 5199. `pnpm test:e2e` boots one itself (or reuses one
already running there) and additionally exercises the screen a person actually
looks at. Run all three before calling a change done.

Pairing needs `ALLOW_UNCHARGED_PAIRING="1"` in `.dev.vars` on a checkout with no
Stripe keys — otherwise a join is refused rather than paired for free, which is
the point. `pnpm payment-gate` is the fourth lane: it asserts whichever money
mode the server it is pointed at reports, and it is the only thing that
exercises the charged path through the real Durable Object.

## Style

Biome, single quotes, no semicolons, 100 columns. Comments explain *why*, and
only where a reader would otherwise wonder.

<!-- BEGIN LOOM ORCHESTRATION -->
This repository uses [Loom](https://github.com/rjwalters/loom) for AI-powered development orchestration — see the Loom repository for the full guide (roles, labels, worktrees, configuration). When installed, Loom also writes a locally-substituted copy of that guide to `.loom/CLAUDE.md`.

Work is coordinated through `loom:` labels on issues and pull requests, and the same roles run either under `loom-daemon` or by hand in an attended session — daemon mode is optional. Create the labels once with `.loom/scripts/sync-labels.sh` (an install ships `.github/labels.yml` but does not create the labels on the forge). A pull request ready for review carries `loom:review-requested`; Judge reviews it and applies `loom:pr` (approved) or `loom:changes-requested`; Doctor fixes a `loom:changes-requested` pull request and returns it to `loom:review-requested`. Only a `loom:pr` pull request gets merged, and always via this repo's merge script (`.loom/scripts/merge-pr.sh`) — never a raw forge merge command such as `gh pr merge`. Full state machine: `.loom/docs/label-state-machine.md`.
<!-- END LOOM ORCHESTRATION -->

<!-- BEGIN REPO-SKILLS -->
This repository has [Repo Skills](https://github.com/rjwalters/repo) v0.14.0 installed —
general repository hygiene and environment commands invoked as `/repo:<command>`. Run
`/repo:help` for the command list, or see `.claude/skills/repo/SKILL.md` for the full
guide. Hygiene commands apply safe, reversible fixes by default and report each
change; run with `--ask` to review first, and `--prune` to allow irreversible
removals. Managed by `install.sh` — edit outside the markers only.
<!-- END REPO-SKILLS -->

<!-- BEGIN ANVIL -->
This repository uses [Anvil](https://github.com/rjwalters/anvil) for AI-powered artifact creation. See `.anvil/CLAUDE.md` for the full guide (skills, rubric, state machine). To upgrade Anvil, re-run `install-anvil.sh .` from the anvil checkout without `--skills=` to pick up newly-shipped skills; pass `--skills=...` only to install a strict subset.
In Claude Code, invoke an installed skill via `/anvil:<skill>` (e.g. `/anvil:paper-draft <slug>`) -- the per-skill registration shim lives at `.claude/skills/anvil-<skill>/`.
<!-- END ANVIL -->

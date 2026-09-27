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
instance per geohash cell** — the cell is the matching market. Durable Objects
process one event at a time, which is what makes "two buyers paired to the same
third party" impossible without any locking. Per-connection state lives in the
WebSocket's hibernation attachment (`serializeAttachment`), not in instance
fields, so an idle cell can be evicted between rushes without losing the queue.
D1 is the durable ledger of settled splits; the Durable Object owns only live
state.

## Rules that matter

- **Money is integer cents, everywhere.** Never a float. `shared/economics.ts`
  is the only place that divides money, and `divideCents` guarantees the shares
  sum back to the total exactly. Indivisible remainders go to the orderer.
- **Deal prices are data, not literals.** They live in `shared/deals.ts` and
  vary by market and promo. Never inline `799` at a call site.
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
  themselves in someone else's market. It also derives the *coordinates* by
  default: `shared/location.ts` resolves client-supplied coords (opt-in only) →
  Cloudflare edge geo (`request.cf`) → a fixed demo origin, so pairing never
  needs a location prompt. `cf` is untrusted and can be missing or partial —
  parse it through `parseCoords`, never straight into `geohash()`. Miniflare
  caches a real `cf` locally, so `pnpm dev` usually gets rung 2; with no usable
  one (offline, or unit tests) rung 3 keeps the flow alive.
- **Identity comes from the session, never from a message.** The pool socket is
  authenticated at upgrade time and the display name a buddy sees is read off
  the session in KV. A `name` on the wire is ignored, not trusted.
- **A split settles only when both sides confirm the handoff.** The orderer
  holds a random pickup code (never derived from the match id, and never sent
  to the receiver); the receiver reads it off them. One side confirming alone
  times out into a dispute, and completing the handshake is the only thing that
  writes a row to the D1 ledger.

## Commands

```bash
pnpm dev          # Vite + Worker together, full stack
pnpm test         # vitest — pure logic (settlement, geo, matchmaking, protocol)
pnpm smoke        # end-to-end pairing against a running `pnpm dev`
pnpm typecheck    # wrangler types && tsc --noEmit
pnpm lint         # biome
pnpm run deploy    # vite build && wrangler deploy (pnpm deploy is a pnpm builtin)
```

`pnpm test` does not cover the Durable Object. `pnpm smoke` does, and needs a
dev server on port 5199. Run both before calling a change done.

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

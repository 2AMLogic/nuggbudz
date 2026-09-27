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
- **The server derives the cell, never the client.** Otherwise a caller parks
  themselves in someone else's market.

## Commands

```bash
pnpm dev          # Vite + Worker together, full stack
pnpm test         # vitest — pure logic (settlement, geo, matchmaking, protocol)
pnpm smoke        # end-to-end pairing against a running `pnpm dev`
pnpm typecheck    # wrangler types && tsc --noEmit
pnpm lint         # biome
pnpm deploy       # vite build && wrangler deploy
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

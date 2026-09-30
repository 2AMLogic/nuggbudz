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
- **A wire version is an appended changelog entry, never a typed number.**
  `PROTOCOL_VERSION` is derived from the last entry of `PROTOCOL_HISTORY` in
  `shared/protocol.ts`; bump it by appending there, and never renumber a landed
  entry. Twice in one night two branches typed the *same* number for incompatible
  message sets (#91) and `git` reported no conflict either time — it cannot, since
  both sides write the same literal — and `vitest`, `tsc` and `biome` were all
  happy, because one integer everybody agrees on is exactly what they check for.
  Appending conflicts on purpose: two branches put a different line in the same
  place. `test/protocol-merge.test.ts` runs that two-branch merge for real in a
  throwaway repo, with the old bare literal changed on both branches in the same
  merge as a positive control that still comes out clean, and
  `test/protocol.test.ts` replays the changelog against `PROTOCOL_MESSAGE_TYPES`
  so a mis-resolved conflict is caught on the merged tree too. The entries are
  also the only record of *what* changed in version N, which is what both
  collisions had to be reconstructed from.
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
  coordinate at a call site. **Distance is also the only isolation mechanism** —
  never keep two scenarios apart by giving them different *deal ids* (or
  merchants, or sauces). That couples the suite to `shared/deals.ts`, and it is
  what broke `main` twice in one afternoon (#57, cases 3 and 4): a branch that
  gated pairing to one chain and a branch whose fixtures used a second and third
  chain id to separate buyers merged with no conflict, textually clean, green in
  `vitest`, and dead at runtime in `pnpm smoke`. The catalogue is a product
  decision that will keep changing; a hundred kilometres will not.
- **Identity comes from the session, never from a message.** The pool socket's
  identity is fixed at upgrade time — the session, or with none the anonymous
  `demo:` identity off the browser's cookie — and the display name a buddy sees
  is read off the session in KV. A `name` on the wire is ignored, not trusted,
  and a caller cannot supply a user id on any path. For an anonymous identity
  only, the display name itself is caller-supplied — on the upgrade query
  string, not on any message — since there is no session to read one from.
- **Sign-in guards the seat, not the socket (#150).** Every socket is welcomed
  and shown the market; `seatVerdict` in `shared/identity.ts`, called from the
  pool's `join` path and nowhere else, is the one answer to whether an identity
  may take a seat, and `ALLOW_DEMO_PAIRING` is the one input it reads for an
  anonymous one. Never decide it a second time at the upgrade or in the client
  (the client reads `/api/health`'s `demoPairing` to offer a name field, never
  to skip the gate): an anonymous identity is `demo:`, `paymentDisposition` answers `demo`
  for it before Stripe is consulted, so a seat that slipped past this gate on a
  charged deployment is a free pair. A socket without a seat is sent `market`
  counts and never the `buddies` roster. The upgrade limiter is the flood
  backstop the old 401 used to be, so anonymous upgrades keep their own tighter
  window (`POOL_ANON_UPGRADE_LIMIT`) and a per-address concurrent cap in the pool
  (`POOL_ANON_SOCKETS_PER_IP`) — don't fold them into the signed-in bucket.
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
- **Standing is a band, never a count, and never a queue order.** D1 keeps
  per-account completion / no-show / late-cancel counters, and
  `shared/reputation.ts` is the only thing allowed to read them: `standingBand`
  is the only way out, `describeStanding` is the only copy that renders one, and
  the wire carries the band alone — there is nothing in a `matched` message a
  buyer could be shamed with. In matching it is a *tiebreak inside a window
  anchored to the longest waiter's own join time*, which is what keeps the queue
  starvation-free; `test/matchmaker.test.ts` drives that as a simulation. Never
  widen it into a score that sorts the queue.
- **A split settles only when both sides confirm the handoff.** The orderer
  holds a random pickup code (never derived from the match id, and never sent
  to the receiver); the receiver reads it off them. One side confirming alone
  times out into a dispute, and completing the handshake is the only thing that
  writes a row to the D1 ledger.
- **The QR is a faster way to do what the protocol already requires, not a new
  channel.** It carries a **handoff link** for the pickup code — `/h/<code>`,
  built by `shared/handoff.ts` — and nothing else: no match id, no user id, no
  session token. `pickupQrMatrix` takes a *code and an origin* rather than a
  string, so no call site can widen the payload later. It is a link rather than
  the bare code (#92 said otherwise, #101 overruled it) because a phone's own
  camera app is the only scanner a borrowed handset has, and because the payload
  was never the thing protecting the handoff: a symbol held up in a queue is
  public to everyone behind you, and **the code always was too.** What protects
  it is that `confirm_pickup` arrives on an authenticated socket and the server
  checks that socket is the receiver of that match. **Opening the link confirms
  nothing** — it hands the code to the session that opened it, which still taps.
  A scan (`CodeScanner`, which accepts a bare code or a link indifferently) fills
  the same field a receiver would have typed into and `confirm_pickup` validates
  it unchanged, which is why none of this needed a protocol change or a
  `PROTOCOL_VERSION` bump. One decode path on both phones — a pure-JS decoder,
  because `BarcodeDetector` does not exist on iOS Safari and a fallback is the
  untested path precisely when it runs. Typing stays on equal footing: a denied
  camera, an aborted decoder chunk, no camera or bad light must still complete a
  handoff. `e2e/scan.spec.ts` proves the in-app path with a *real camera* reading
  the orderer's *real* rendered canvas, and `e2e/handoff.spec.ts` the link path,
  because a decoder with a green unit test and no wiring to `confirm_pickup` is
  this repo's fifth defect of one shape. **No physical phone and no native camera
  app has run any of it** — that is #98, and a green Chromium suite must not be
  read as if it had.
- **A demo identity is sticky per browser, and that is what costs the
  single-device demo.** `/api/health` sets a cookie, `worker/index.ts` reads it
  at upgrade, and two tabs of one browser are therefore one buyer. It has to be:
  the camera app opens the handoff link in a *new tab*, which is a new socket,
  and a per-socket id would arrive at the handoff as a stranger. The accepted
  cost (#101, the operator's call) is that the self-match guard now fires in
  ordinary use — so it names the tab you are already in rather than failing
  generically — and **pairing needs two devices.** `worker/pool.ts` adopts a
  second socket of one identity into a *released* handoff and no earlier, and a
  disconnect only tears a match down when the last socket on that side goes.
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
- **A refund Stripe refused is a `holds` row, and holds are parallel to disputes,
  never folded into them.** A tombstone lives in one cell's storage and there is
  no registry of live cells, so until #85 a refused refund on a *non-dispute*
  teardown was money nobody could enumerate — and unlike a dispute there is no
  human in the loop by construction, because nobody raised it. `retireMatch` now
  takes a **required** `TeardownReason`, and files a `holds` row when
  `parseHoldReason` answers it *and* `holdsCollectedMoney` is true — before the
  `match:` key is deleted, the same ordering `persistTerminal` enforces. The two
  predicates are both load-bearing: `hasOutstandingMoney` (pending *or*
  collected) is what keeps a tombstone, and `holdsCollectedMoney` (collected
  alone) is what makes a hold, because a `pending` leg is a webhook to wait for
  rather than money anybody has lost. A dispute's hold is deliberate and already
  in `disputes`, so it names itself `'disputed'` and files nothing — the same
  money in two operator queues is worse than in one. `GET /api/admin/holds` is
  the queue; `POST /api/admin/holds/:matchId/retry` is the only action, because
  nobody *decided* a hold and there is nothing to resolve. Re-asking is safe
  because of `refundIdempotencyKey`, and `stampHoldRefund` runs only after Stripe
  answers — `refunded_cents` NULL means no retry has been answered for, which is
  not `0`. A D1 write that fails parks the row under `holdfile:` and
  `reconcileHolds` replays it off the alarm, because a hold is filed for a record
  that is still `pending` and `reconcileTerminal` skips those by design.
- **A honeypot is a decoy, and everything that makes it safe is structural.**
  `shared/honeypot.ts` mints `honeypot:<uuid>` identities that populate an empty
  market and act as an abuse tripwire; `HONEYPOT_BUYERS` answers that one
  question and is off by default, on a charged deployment as much as anywhere
  else. The money gate answers `honeypot` from identity *before* the Stripe
  secrets are read, so a decoy cannot reach the processor — and
  `codeAtMatchTime('honeypot')` is **false**, which is the single answer the
  whole feature rests on: no code released means no confirmation recorded, which
  makes `matches` (needs both) and `disputes` (every route needs one)
  unreachable rather than merely avoided. A decoy then **excuses itself** through
  the refunding `buddy_left` teardown well inside the unconfirmed-match window,
  because a decoy that went silent would walk a real buyer into the hold a
  dispute deliberately keeps — and it books no `late_cancel` against them, which
  `cancelMatch` and `handleDisconnect` both name and skip. In matching it is a
  **fallback, never a candidate**: `findMatch` drops every decoy the moment a
  real buyer is eligible, so the starvation-free window is computed over real
  buyers only, and a chosen decoy is always the *receiver* — nobody is ever sent
  to a counter to meet somebody who does not exist. Its chat replies come from a
  fixed table: pure, offline, no model, deliberately, because a model would make
  the sentence under the chat box false. A signal records which match, which
  caller and which kind, and **never what was said**.
- **A finished match leaves the Durable Object only once D1 has it.** A settled
  split goes to `matches`, a dead handshake to `disputes`, and money a teardown
  could not hand back to `holds` — each a table of its own, never a status
  column, so every revenue query stays a plain `WHERE settled_at IS NOT NULL`.
  `persistTerminal` is the one answer both terminal paths read, and the
  record is deleted **after** it returns true, never before; a failed write keeps
  the record and `reconcileTerminal` replays it off the next alarm. Get that
  order backwards and nothing looks broken until a D1 blip erases the only
  evidence two strangers are out of pocket.
- **The operator surface is a session plus an allowlist, never a shared token.**
  `OPERATOR_USER_IDS` names `users.id` values and `shared/operators.ts` drops
  anything not shaped like an id a sign-in could mint. A resolution moves money
  and stamps `resolved_by`, which a token could not do; unset means *no*
  operators and `/api/admin/*` answers the same 404 as an unknown path. The four
  resolutions are named for what they do to the money (`refund_receiver`, not
  `sided_with_receiver`), and `refunded_cents` is stamped only after Stripe
  answers — `NULL` means "not answered for", which is not `0`.
- **A resolution is decided once and paid out until it lands.** The `409` guards a
  second *decision*, never a second *attempt* at the same one: a refund Stripe
  declined, or a resolution whose refund call never completed, was money held with
  no route back through the only endpoint that can release it (#103).
  `resolutionDisposition` in `shared/disputes.ts` is the one place that tells the
  three apart — `decide`, `retry`, or a `409` naming itself `decided_differently`
  or `refund_complete` — and it reads `outstanding_cents`, which is what the
  resolution promised to return and has not, *as the Durable Object reported it*.
  Never derive that from `refunded_cents` against `held_cents`: `settled` refunds
  nobody on purpose and would read as forever unfinished, and `refund_orderer`
  pays back one half of money that is still holding the other. A retry claims
  nothing and rewrites nothing — `resolved_by`, `resolved_at`, `resolution` and the
  note are the decision, and only the money moves — so `refunded_cents`
  accumulates like `holds.refunded_cents` rather than being `SET`, because the
  object reports what *this* attempt recovered. A dispute's held money still files
  no `holds` row: it is already in one operator queue.
- **A comment body is never a bare `@`-token, and a review verdict is never
  posted by hand.** `gh pr comment --body @path` does not expand `@path`, it
  posts the literal string — and `@-`, the stdin spelling of the same mistake,
  is what destroyed the approving verdict on PR #30 (#52). Both of that
  verdict's comments posted as the two characters `@-`, so the approval carried
  no rationale *and* no `loom:verdict-sha` marker; `verdict-staleness-guard.sh`
  read `UNVERIFIABLE`, which fails safe by **keeping** the verdict, and the PR
  merged on a tree the head had moved off twenty seconds later. Loom's guard
  denies `--body @path` only when the character after the `@` is path-shaped, so
  that `@reviewer` prose stays allowed — which is exactly the carve-out `@-` fell
  through. `scripts/guard-comment-body-at.mjs` is this repo's own `PreToolUse`
  hook for that gap: it refuses a body that is *entirely* one `@`-token unless
  the token is a valid GitHub handle, and refuses an empty comment. It lives in
  `scripts/` and is wired from `.claude/settings.json` because `.loom/hooks/` and
  `.claude/skills/repo/hooks/` are installed copies an upgrade overwrites, and
  because the guard actually running here is neither of them but the
  machine-level Loom install, which this checkout cannot patch. A verdict goes
  through `.loom/scripts/post-verdict.sh` — it appends the marker itself and
  already refuses `@-`, `@path` and an empty body — never a raw `gh pr comment`.
  `test/verdict-guard.test.ts` drives both through the real executables, with the
  `@mention` and `--body-file -` cases as controls, because a guard with a green
  unit test and no wiring is this repo's recurring defect.
- **A green pull request is not a green `main`, and the merge result is watched
  rather than gated (#57).** Per-PR CI tests the branch's own merge-base and
  `main`'s tree, never the tree the merge produces. Four times in one afternoon a
  pull request that was individually correct and green broke `main` when it
  landed, and three of those four had **no conflict at all** — identical edits
  merge clean by construction, and so do edits to different lines of two files
  whose *semantics* interact. Two were visible only in `pnpm smoke`; `vitest` was
  green for both, because it never reaches the Durable Object. Every job in
  `.github/workflows/ci.yml` therefore runs on `push: branches: [main]` as well as
  on pull requests — that half has always existed, and it is the half nobody was
  reading. The `main-red-alert` job is the reading: on a failed *or cancelled*
  push-triggered run it opens **one** `loom:auditor` issue and comments on that
  same issue every time after, so a red `main` is handed to a human or the Auditor
  role instead of being found by the next person to run the suite locally. It
  `needs` *every other job*, and `test/main-red-alert.test.ts` compares that list
  against the workflow's own jobs — a job added later and left out of it would be
  watched by nobody with nothing looking wrong — and drives the filing half
  against a stub forge, because a notifier nothing invokes is this repo's recurring
  defect wearing a different hat. What is deliberately **not** here is the gate:
  "require branches to be up to date before merging", or a merge queue, is the only
  thing that catches this class *before* it lands, and it is a repo-admin setting
  no workflow can grant itself — README "CI, and why a green pull request is not a
  green `main`" records that decision, what to flip, and who has to flip it. Never
  read the alert as if it were the gate; it reports a wrong `main`, it does not
  prevent one.

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
pnpm honeypot-check # decoy buyers, in whichever mode that server reports
pnpm fake-stripe  # a local stand-in for Stripe's REST API, for the charged path
pnpm test:e2e     # Playwright — two browsers driving the real UI end to end
pnpm typecheck    # wrangler types && tsc --noEmit
pnpm lint         # biome
pnpm run deploy      # strict deploy — sign-in only (`pnpm deploy` is a pnpm builtin)
pnpm run deploy:demo # stage deploy — adds --var ALLOW_DEMO_PAIRING:1, see README "Demo pairing"
```

`pnpm test` does not cover the Durable Object *in its runtime*. `pnpm smoke`
does, and needs a dev server on port 5199. `pnpm test:e2e` boots one itself (or
reuses one already running there) and additionally exercises the screen a person
actually looks at. Run all three before calling a change done.

The one exception is deliberate and narrow: `vitest.config.ts` aliases
`cloudflare:workers` to `test/stubs/cloudflare-workers.ts` — a bare base class,
nothing more — so `NuggPool`'s own methods can be driven against a fake
`ctx`/`DB` in plain Node. It exists for the defect class the runtime lanes cannot
see cheaply: bookkeeping *inside* one `alarm()` tick, where a wrong answer is a
silent extra D1 write or a stale re-armed alarm rather than a broken handshake
(#87 — a `Map` keyed by the `match:<id>` storage key while all three of its
prunes passed a bare `matchId`, so every prune was a no-op that `tsc`, `biome`
and a source-string assertion all read as correct). Never let a stub grow
behaviour a test then asserts about; anything about the real runtime still
belongs in `smoke` or `test:e2e`.

Pairing needs `ALLOW_UNCHARGED_PAIRING="1"` in `.dev.vars` on a checkout with no
Stripe keys — otherwise a join is refused rather than paired for free, which is
the point. `pnpm test:e2e` also needs `POOL_UPGRADE_LIMIT="300"` (and
`POOL_ANON_UPGRADE_LIMIT="300"`) there: the
limiter keys on `CF-Connecting-IP`, which `pnpm dev` never sets, so locally every
client shares one bucket and the suite trips a limit sized for a venue NAT —
visible as "Lost the connection. Try again.", not as a refusal. `pnpm payment-gate` is the fourth lane: it asserts whichever money
mode the server it is pointed at reports, and it is the only thing that
exercises the charged path through the real Durable Object. `pnpm honeypot-check`
is the fifth, and needs `HONEYPOT_BUYERS="1"` (plus Stripe "configured" at a dead
address, the way CI sets it) to exercise the decoy path; with the flag off it
asserts the other direction — that a market stays empty.

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

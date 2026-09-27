# Source of truth — end-to-end runs

The shipped slide's only quantitative claim is a run recorded here. Three runs
are recorded because the deployed build and the branch the slide's count comes
from are not the same commit today, and because this branch was merged with
`main` after Run 1 was taken.

**The slide's `66/66` comes from Run 3**, the merged tree — the one that will
actually land. Run 1 is kept as written because it is the run that existed when
it was recorded; it is superseded, not wrong, and its numbers are not edited
after the fact.

## Run 1 — this branch (the offered-deal gate), full local stack

```bash
pnpm dev --port 5210                     # in one shell
BASE=http://localhost:5210 pnpm smoke    # in another
```

A non-default port, deliberately: with several checkouts of this repo on one
machine a `pnpm smoke` against the default 5199 can be answered by somebody
else's dev server, and a green run from the wrong build is worse than a red one.
The listener on 5210 was confirmed to be this worktree's own process before the
numbers below were believed.

`scripts/smoke.mjs` seeds its own sessions into the dev server's local KV
namespace — the pool socket requires a session since `ec0aec7`, and an OAuth
round trip cannot be driven unattended. Everything else is the real Worker, the
real Durable Object, real WebSockets, real D1 and KV bindings.

Output, 2026-09-27, at commit `e873864` (`feature/issue-28`, rebased on `a70b0ea`):

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":3}
PASS  deals catalogue returned (McDonald-only) — 1 deals
PASS  mcd half is $4.49 — 449
PASS  mcd spread is $5.99 — 599
PASS  party of 4 splits 20pc evenly
PASS  party of 1 rejected — status 400
PASS  unknown deal 404s — status 404
PASS  a gated deal is not quotable — 404/404
PASS  anonymous /auth/me is 401 — status 401
PASS  seeded session resolves to its user — {"user":{"id":"smoke-user-robb","displayName":"Robb","email":null,"avatarUrl":null}}
PASS  a forged session id is not a session — status 401
PASS  unauthenticated pool upgrade is 401 — 401
PASS  unauthenticated websocket never opens
PASS  google start either redirects or reports it is unconfigured — status 503
PASS  a callback with an unknown state is a 4xx, not a 500 — status 503
PASS  logout clears the cookie — nb_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax
PASS  logout revokes the session — status 401
PASS  welcome carries a cell — 9q8znb
PASS  welcome carries the authenticated identity — {"id":"smoke-user-robb","name":"Robb"}
PASS  first buyer queues — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  both buyers matched — 7d6ae6bb-63d9-4aed-9544-1aaaf037dc0a / 7d6ae6bb-63d9-4aed-9544-1aaaf037dc0a
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer AGX8H3
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — AGX8H3 vs 7d6ae6bb-63d9-4aed-9544-1aaaf037dc0a
PASS  distant buyer waits alone — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  survivor told their bud left
PASS  survivor requeued — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  handshake pair matched in their own cell — orderer/receiver
PASS  a wrong code is rejected — bad_pickup_code
PASS  a receiver cannot confirm with no code at all — bad_pickup_code
PASS  a wrong code completes nothing
PASS  a wrong code confirms nothing
PASS  both sides see the receiver confirm — receiver/receiver
PASS  the orderer is still owed a confirmation — orderer
PASS  a dispute deadline is armed on the half-confirmed match — 1790549883439
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — d0a28c47-9393-40be-8559-8cd1553856a2
PASS  completion is stamped — 1790549584058
PASS  the settled split is written to the ledger — {"match_id":"d0a28c47-9393-40be-8559-8cd1553856a2","deal_id":"mcd-nuggets-20","cell":"9q9p3w","party_size":2,"total_collected_cents":898,"cogs_cents":799,"platform_fee_cents":99,"distance_meters":14.166510726194598,"created_at":1790549582231,"settled_at":1790549584058}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":449},{"role":"receiver","pay_cents":449}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"82d9de56-8bb5-4534-9456-62f104c7f712","confirmedBy":"receiver","reason":"buddy_left"}
PASS  a disputed match never settles
PASS  a disputed match does not quietly requeue the survivor
PASS  a disputed match is never booked — []
PASS  a disputed match cannot be confirmed away — not_matched
PASS  garbage rejected — bad_message
PASS  confirming without a match is refused — not_matched
PASS  unknown deal rejected over ws — unknown_deal
PASS  a gated deal is refused on the pairing path — unknown_deal
PASS  every gated deal is refused on the pairing path — unknown_deal
PASS  a refused gated join never queues the buyer

ALL CHECKS PASSED
```

## Run 2 — the deployed Worker, pre-sign-in build

```bash
BASE=https://nuggbudz.personal-account-251.workers.dev pnpm smoke
```

Run 2026-09-27 against the deployment at commit `32dad69`, which was the build
serving the URL at the time of this run (`/api/health` reported `protocol: 1`;
the auth routes 404'd because that build predated them). **22/22 checks passed**, including: the
catalogue served with settlement and spread computed by `shared/economics.ts`;
two independent WebSocket clients in cell `9q8znb` paired into one `matchId`
with complementary roles; the longest waiter made orderer; each side charged
$4.49 and credited $2.50; a 43 m buddy distance; a buyer outside the radius left
waiting; a survivor requeued when their buddy disconnected; malformed frames and
unknown deals rejected.

That run cannot be reproduced against the deployment after the next deploy: the
pool socket will then require a session, and `pnpm smoke` seeds sessions into a
**local** KV namespace only. Runs 1 and 3 are the reproducible ones, and
Run 3 is the one the slide quotes.

## Run 3 — this branch merged with `main`, full local stack

The authoritative run for the slide. Taken after merging `origin/main` into
`feature/issue-28` — first `8f365ba`, which had picked up the cell map's
roster-broadcast checks via #39/#29, then `bcf6318`, which added demo pairing
and the `nuggbudz.com` custom domain via #40. Recorded here because no
single-branch run describes the merged tree:

```bash
pnpm dev --port 5219                     # in one shell
BASE=http://localhost:5219 pnpm smoke    # in another
```

Port 5219 for the same reason Run 1 used a non-default port, and the listening
pid's `cwd` was confirmed to be this worktree (`pid 49209` ->
`.loom/worktrees/issue-28`) before any of the output below was believed.

Two things about the merged tree are worth stating, because neither branch could
have observed them alone:

- The count is **66**, not the 61 both branches independently claimed. Each had
  corrected the slide to `61/61` for its own four checks, so `deck.md` merged
  with no conflict while the true total moved past it.
- The merge was briefly **red**, not merely miscounted. `main`'s
  roster-broadcast checks isolated their buyers on `wendys-nuggets-20` and
  `bk-nuggets-20`, which is precisely what this branch's offered-deal gate
  refuses, so the suite died on `Kim: timed out waiting for waiting`. Those
  checks now isolate by cell (`9q8yx1`, a neighbourhood nothing else in the
  suite touches) and by distance — both buyers inside one cell but 1055 m
  apart, past the 800 m `MATCH_RADIUS_METERS`, the "cell-edge buddies" case
  `wrangler.jsonc` documents. That makes the roster assertion *stronger* than
  the one it replaces: a buddy appears on the map whom this buyer could not
  legitimately be matched with.

Output, 2026-09-27, on the merge of `feature/issue-28` into `bcf6318`:

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":3,"demoPairing":false}
PASS  deals catalogue returned (McDonald-only) — 1 deals
PASS  mcd half is $4.49 — 449
PASS  mcd spread is $5.99 — 599
PASS  party of 4 splits 20pc evenly
PASS  party of 1 rejected — status 400
PASS  unknown deal 404s — status 404
PASS  a gated deal is not quotable — 404/404
PASS  anonymous /auth/me is 401 — status 401
PASS  seeded session resolves to its user — {"user":{"id":"smoke-user-robb","displayName":"Robb","email":null,"avatarUrl":null}}
PASS  a forged session id is not a session — status 401
PASS  unauthenticated pool upgrade is 401 — 401
PASS  unauthenticated websocket never opens
PASS  google start either redirects or reports it is unconfigured — status 503
PASS  a callback with an unknown state is a 4xx, not a 500 — status 503
PASS  logout clears the cookie — nb_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax
PASS  logout revokes the session — status 401
PASS  welcome carries a cell — 9q8znb
PASS  welcome carries the authenticated identity — {"id":"smoke-user-robb","name":"Robb"}
PASS  first buyer queues — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  both buyers matched — 93c13c74-d85e-4150-900a-6d7c2242bf6b / 93c13c74-d85e-4150-900a-6d7c2242bf6b
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer XTEVH8
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — XTEVH8 vs 93c13c74-d85e-4150-900a-6d7c2242bf6b
PASS  distant buyer waits alone — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  survivor told their bud left
PASS  survivor requeued — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  handshake pair matched in their own cell — orderer/receiver
PASS  a wrong code is rejected — bad_pickup_code
PASS  a receiver cannot confirm with no code at all — bad_pickup_code
PASS  a wrong code completes nothing
PASS  a wrong code confirms nothing
PASS  both sides see the receiver confirm — receiver/receiver
PASS  the orderer is still owed a confirmation — orderer
PASS  a dispute deadline is armed on the half-confirmed match — 1790553072000
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — 45fd0088-d763-43ec-9ece-7eace384d9c9
PASS  completion is stamped — 1790552772627
PASS  the settled split is written to the ledger — {"match_id":"45fd0088-d763-43ec-9ece-7eace384d9c9","deal_id":"mcd-nuggets-20","cell":"9q9p3w","party_size":2,"total_collected_cents":898,"cogs_cents":799,"platform_fee_cents":99,"distance_meters":14.166510726194598,"created_at":1790552770783,"settled_at":1790552772627}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":449},{"role":"receiver","pay_cents":449}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"03c410eb-7ce9-49b8-950d-6ae536f5ab7a","confirmedBy":"receiver","reason":"buddy_left"}
PASS  a disputed match never settles
PASS  a disputed match does not quietly requeue the survivor
PASS  a disputed match is never booked — []
PASS  a disputed match cannot be confirmed away — not_matched
PASS  garbage rejected — bad_message
PASS  confirming without a match is refused — not_matched
PASS  unknown deal rejected over ws — unknown_deal
PASS  a gated deal is refused on the pairing path — unknown_deal
PASS  every gated deal is refused on the pairing path — unknown_deal
PASS  a refused gated join never queues the buyer
PASS  the first buyer in a fresh cell has an empty roster — 9q8yx1 []
PASS  the roster carries a cell buddy who is out of pairing range — 9q8yx1 {"type":"waiting","waiting":2,"queuedAhead":1,"buddies":[{"lat":37.71087854832914,"lng":-122.38736388350911}]}
PASS  a buyer already queued gets a fresh roster broadcast when someone new joins the cell — 1 -> 2
PASS  the broadcast roster carries a position for the newcomer — [{"lat":37.71559468199784,"lng":-122.37726845094652}]
PASS  the broadcast never carries an exact coordinate for anyone else — [{"lat":37.71559468199784,"lng":-122.37726845094652}]

ALL CHECKS PASSED
```

## What these runs do and do not establish

**Do**: the pairing protocol works end to end on real infrastructure — cell
routing, single-market matching, complementary roles, identical settlement,
radius exclusion, requeue on disconnect, hostile-input rejection, that a
buddy's display name comes from the session rather than from anything a client
sent, and that a split reaches the D1 ledger only when both sides confirm the
handoff — a wrong code settles nothing, and one side confirming alone arms a
dispute deadline instead of booking a row.

**Do not**: establish demand, retention, or anything about a real buyer. There
are no users. Two scripted clients are not two hungry strangers, and the deck
must not present this as traction beyond "the system works".

## Why the deck quotes a check count

`66/66` is the count of `check()` assertions in `scripts/smoke.mjs`, counted
from the source by `countSmokeChecks()` in `scripts/deck-ledger.ts`. Adding an
assertion changes the count, which fails `test/deck.test.ts` until the slide is
updated — the same drift guard the money figures get. The count grew 22 -> 32
when Google sign-in landed, 32 -> 57 when the two-sided pickup handshake
landed, 57 -> 61 when the cell map's roster-broadcast checks landed, and 61 ->
66 when the offered-deal gate got assertions on the paths that actually pair and
settle; every time the deck was corrected by that failure rather than by anyone
noticing. The 57 figure is the one caught by 2am-nuggbudz#26: #18 added the
guard and #22 added the assertions, neither branch was red on its own, and
`main` went red on the merge. The 61 figure repeated the lesson one merge later
and more quietly, in two ways at once. The roster-broadcast checks and the
offered-deal checks landed on separate branches that had each already corrected
the slide to the same `61/61`, so the deck merged with **no conflict at all**
while the true count moved past it. And the merge was not only miscounted but
briefly broken: the roster-broadcast checks isolated their buyers by putting
them on a second and third deal id, which is exactly what the offered-deal gate
refuses, so `pnpm smoke` died on `Kim: timed out waiting for waiting` — a red
that neither branch could produce alone, and that `pnpm test` cannot see because
it does not cover the Durable Object. Those checks now isolate by cell and by
distance instead, which is why the count landed on 66 rather than 65.

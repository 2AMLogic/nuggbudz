# Source of truth — end-to-end runs

The shipped slide's only quantitative claim is a run recorded here. Three runs
are recorded because the deployed build and `main` are not the same commit
today, and Run 3 records the reconciled branch tree the claim lands on.

## Run 1 — current `main` (the pickup handshake landed), full local stack

```bash
pnpm dev --port 5199    # in one shell
pnpm smoke              # in another
```

`scripts/smoke.mjs` seeds its own sessions into the dev server's local KV
namespace — the pool socket requires a session since `ec0aec7`, and an OAuth
round trip cannot be driven unattended. Everything else is the real Worker, the
real Durable Object, real WebSockets, real D1 and KV bindings.

Output, 2026-09-27, at commit `86da850`:

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":3}
PASS  deals catalogue returned — 3 deals
PASS  mcd half is $4.49 — 449
PASS  mcd spread is $5.99 — 599
PASS  party of 4 splits 20pc evenly
PASS  party of 1 rejected — status 400
PASS  unknown deal 404s — status 404
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
PASS  both buyers matched — e771581d-92a5-4af3-a6b5-509d67dd89bc / e771581d-92a5-4af3-a6b5-509d67dd89bc
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer P9AJ3Z
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — P9AJ3Z vs e771581d-92a5-4af3-a6b5-509d67dd89bc
PASS  distant buyer waits alone — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  survivor told their bud left
PASS  survivor requeued — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  handshake pair matched on their own deal — orderer/receiver
PASS  a wrong code is rejected — bad_pickup_code
PASS  a receiver cannot confirm with no code at all — bad_pickup_code
PASS  a wrong code completes nothing
PASS  a wrong code confirms nothing
PASS  both sides see the receiver confirm — receiver/receiver
PASS  the orderer is still owed a confirmation — orderer
PASS  a dispute deadline is armed on the half-confirmed match — 1790548916461
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — dbfa7bdd-d54d-4e78-9da0-8002e7eb1faa
PASS  completion is stamped — 1790548617073
PASS  the settled split is written to the ledger — {"match_id":"dbfa7bdd-d54d-4e78-9da0-8002e7eb1faa","deal_id":"wendys-nuggets-20","cell":"9q8znb","party_size":2,"total_collected_cents":948,"cogs_cents":849,"platform_fee_cents":99,"distance_meters":14.17211798152305,"created_at":1790548615244,"settled_at":1790548617073}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":474},{"role":"receiver","pay_cents":474}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"c98c21b0-d357-4e7c-ac0d-b26584bfede7","confirmedBy":"receiver","reason":"buddy_left"}
PASS  a disputed match never settles
PASS  a disputed match does not quietly requeue the survivor
PASS  a disputed match is never booked — []
PASS  a disputed match cannot be confirmed away — not_matched
PASS  garbage rejected — bad_message
PASS  confirming without a match is refused — not_matched
PASS  unknown deal rejected over ws — [{"type":"error","code":"bad_message","message":"could not parse message"},{"type":"error","code":"not_matched","message":"you are not in a match to confirm"},{"type":"error","code":"unknown_deal","message":"no such deal: no-such-deal"}]

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
**local** KV namespace only. Run 1 is the reproducible one.

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

## Why the deck does not quote a check count

The slide used to print `N/N`, where N was the count of `check()` assertions in
`scripts/smoke.mjs`, counted from the source by `countSmokeChecks()` in
`scripts/deck-ledger.ts`, and `test/deck.test.ts` failed until the slide matched.
The count grew 22 -> 32 when Google sign-in landed, 32 -> 57 when the two-sided
pickup handshake landed, and 57 -> 61 when the cell map's roster-broadcast
checks landed. That one line had to be hand-edited by every PR touching
`scripts/smoke.mjs`, so concurrent branches conflicted on it or, worse, bumped
it to the same wrong number and merged clean: 2am-nuggbudz#26 is the case where
#18 added the guard and #22 added the assertions, neither branch was red on its
own, and `main` went red on the merge.

The slide now says every end-to-end check passes, and the test asserts only
that the claim is there and that no count is pinned beside it (#46). The live
count is whatever `pnpm smoke` prints.

## Run 3 — `feature/issue-28` reconciled against `main` (incl. the unpinned deck), full local stack

```bash
pnpm dev --port 5199         # in one shell
pnpm smoke                   # in another
```

Taken on the reconciled tree: the merge commit only moves document and deck
tests, so this identical harness output stands for it. The app is now
McDonald's-only here, and the count the slide no longer prints is whatever
`pnpm smoke` prints; it printed 66 passes, all of them:

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
PASS  both buyers matched — 87c1b7e5-82ec-486a-aaf0-a68e0295a014 / 87c1b7e5-82ec-486a-aaf0-a68e0295a014
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer J5P7JT
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — J5P7JT vs 87c1b7e5-82ec-486a-aaf0-a68e0295a014
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
PASS  a dispute deadline is armed on the half-confirmed match — 1790553747914
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — c1d7dedc-d7b5-483a-bb46-fa96c5d27783
PASS  completion is stamped — 1790553448524
PASS  the settled split is written to the ledger — {"match_id":"c1d7dedc-d7b5-483a-bb46-fa96c5d27783","deal_id":"mcd-nuggets-20","cell":"9q9p3w","party_size":2,"total_collected_cents":898,"cogs_cents":799,"platform_fee_cents":99,"distance_meters":14.166510726194598,"created_at":1790553446705,"settled_at":1790553448524}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":449},{"role":"receiver","pay_cents":449}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"ddeab592-b424-4cf5-812e-e7f64733e624","confirmedBy":"receiver","reason":"buddy_left"}
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

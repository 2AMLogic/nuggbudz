# Source of truth — end-to-end runs

The shipped slide's only quantitative claim is the run below. Two runs are
recorded because the deployed build and the branch the slide's count comes from
are not the same commit today.

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

Run 2026-09-27 against the deployment at commit `32dad69`, which is the build
currently serving the URL (`/api/health` reports `protocol: 1`; the auth routes
404 because that build predates them). **22/22 checks passed**, including: the
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

## Why the deck quotes a check count

`61/61` is the count of `check()` assertions in `scripts/smoke.mjs`, counted
from the source by `countSmokeChecks()` in `scripts/deck-ledger.ts`. Adding an
assertion changes the count, which fails `test/deck.test.ts` until the slide is
updated — the same drift guard the money figures get. The count grew 22 -> 32
when Google sign-in landed, 32 -> 57 when the two-sided pickup handshake landed,
and 57 -> 61 when the offered-deal gate got assertions on the paths that
actually pair and settle; every time the deck was corrected by that failure
rather than by anyone noticing. The 57 figure is the one caught by 2am-nuggbudz#26: #18 added the
guard and #22 added the assertions, neither branch was red on its own, and
`main` went red on the merge.

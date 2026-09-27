# Source of truth — end-to-end runs

The shipped slide's only quantitative claim is the run below. Two runs are
recorded because the deployed build and `main` are not the same commit today.

## Run 1 — current `main` (Google sign-in landed), full local stack

```bash
pnpm dev --port 5199    # in one shell
pnpm smoke              # in another
```

`scripts/smoke.mjs` seeds its own sessions into the dev server's local KV
namespace — the pool socket requires a session since `ec0aec7`, and an OAuth
round trip cannot be driven unattended. Everything else is the real Worker, the
real Durable Object, real WebSockets, real D1 and KV bindings.

Output, 2026-09-27, at commit `05b9799`:

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":2}
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
PASS  both buyers matched — 47266b9e-7431-42bf-a36c-9e9c290d33c7 / 47266b9e-7431-42bf-a36c-9e9c290d33c7
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  distant buyer waits alone — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  survivor told their bud left
PASS  survivor requeued — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  garbage rejected — bad_message
PASS  unknown deal rejected over ws — [{"type":"error","code":"bad_message","message":"could not parse message"},{"type":"error","code":"unknown_deal","message":"no such deal: no-such-deal"}]

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
radius exclusion, requeue on disconnect, hostile-input rejection, and (on
current `main`) that a buddy's display name comes from the session rather than
from anything a client sent.

**Do not**: establish demand, retention, or anything about a real buyer. There
are no users. Two scripted clients are not two hungry strangers, and the deck
must not present this as traction beyond "the system works".

## Why the deck quotes a check count

`32/32` is the count of `check()` assertions in `scripts/smoke.mjs`, counted
from the source by `countSmokeChecks()` in `scripts/deck-ledger.ts`. Adding an
assertion changes the count, which fails `test/deck.test.ts` until the slide is
updated — the same drift guard the money figures get. The count grew from 22 to
32 when Google sign-in landed, and the deck was corrected by that failure rather
than by anyone noticing.

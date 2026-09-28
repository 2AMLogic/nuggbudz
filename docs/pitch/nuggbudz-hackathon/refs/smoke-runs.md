# Source of truth — end-to-end runs

The shipped slide claims every end-to-end check passes and names no count (#46);
these are the runs behind that claim. Run 6 is the most recent, and the earlier
runs are kept exactly as they were recorded — the deployed build and `main` have
never been the same commit, and the count has moved at nearly every step, up as
well as down. No run is edited after the fact: a superseded count is history, not
a mistake to tidy away.

Runs are numbered in the order they were **taken**, not the order they were
merged, which is how two branches that each recorded a "Run 3" were reconciled:
see the note under Run 5.

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

## Run 3 — promptless pairing, full local stack

```bash
pnpm dev --port 5211                          # in one shell
BASE=http://localhost:5211 pnpm smoke         # in another
```

Port 5211 rather than the usual 5199 only because other dev servers were up on
this machine; `BASE` is the knob. The seven new assertions over run 1 are the
location fallback: an unusable coordinate refused rather than quietly relocated,
`welcome` naming the rung that placed each socket, and — the one that matters on
a borrowed phone — two buyers who send **no coordinates at all**, in neither the
upgrade nor the join, still resolving a cell and pairing with each other. Their
buddy distance is 0 m because both were placed at the same server-derived origin.

Output, 2026-09-27, at commit `9baedc5`:

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":4,"demoPairing":false}
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
PASS  an unusable coordinate is refused rather than relocated
PASS  welcome carries a cell — 9q8znb
PASS  welcome carries the authenticated identity — {"id":"smoke-user-robb","name":"Robb"}
PASS  welcome names the rung that placed the socket — client
PASS  first buyer queues — {"type":"waiting","waiting":1,"queuedAhead":0}
PASS  both buyers matched — 9a57841d-7867-48c7-900e-f7d1c276d56b / 9a57841d-7867-48c7-900e-f7d1c276d56b
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer AFX6V5
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — AFX6V5 vs 9a57841d-7867-48c7-900e-f7d1c276d56b
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
PASS  a dispute deadline is armed on the half-confirmed match — 1790550458610
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — a2e66ac0-9a8d-4e28-9462-ca2dc44b0ae4
PASS  completion is stamped — 1790550159233
PASS  the settled split is written to the ledger — {"match_id":"a2e66ac0-9a8d-4e28-9462-ca2dc44b0ae4","deal_id":"wendys-nuggets-20","cell":"9q8znb","party_size":2,"total_collected_cents":948,"cogs_cents":849,"platform_fee_cents":99,"distance_meters":14.17211798152305,"created_at":1790550157401,"settled_at":1790550159233}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":474},{"role":"receiver","pay_cents":474}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"f93cb04e-a213-42b4-95d1-76689e4506c6","confirmedBy":"receiver","reason":"buddy_left"}
PASS  a disputed match never settles
PASS  a disputed match does not quietly requeue the survivor
PASS  a disputed match is never booked — []
PASS  a disputed match cannot be confirmed away — not_matched
PASS  a socket with no coordinates still resolves a cell — 9q8yyk
PASS  and says which rung placed it, never claiming an exact fix — edge — 'edge' when request.cf carries coordinates, 'demo' when it does not
PASS  two buyers who never shared their location pair anyway — d5d1caa0-d978-43dd-8fbe-cbdc702986c2 / d5d1caa0-d978-43dd-8fbe-cbdc702986c2
PASS  the split is the same as any other pairing on this deal — 474/474 vs 474
PASS  distance is measured from the server-resolved origin — 0m
PASS  garbage rejected — bad_message
PASS  confirming without a match is refused — not_matched
PASS  unknown deal rejected over ws — [{"type":"error","code":"bad_message","message":"could not parse message"},{"type":"error","code":"not_matched","message":"you are not in a match to confirm"},{"type":"error","code":"unknown_deal","message":"no such deal: no-such-deal"}]

ALL CHECKS PASSED
```

`locationSource: edge` above is miniflare serving a real cached `cf` from
`node_modules/.mf/cf.json` (`latitude: "37.77493"`, hence cell `9q8yyk` rather
than the demo origin's `9q8znb`). Deleting those two fields from that file and
restarting was run again and reported `demo` with cell `9q8znb`, all 64 checks
still passing — which is the local-dev rung, and the reason it exists.

## Run 4 — the merge with the cell map, full local stack

```bash
pnpm dev --port 5225                          # in one shell
BASE=http://localhost:5225 pnpm smoke         # in another
```

Port 5225 rather than 5199 because other dev servers were up on this machine;
`BASE` is the knob. This is the first run against both branches at once: the
promptless-location work of run 3 (64 checks) merged with the cell map's
roster-broadcast checks that landed on `main` (61 checks). Neither number
survives the merge — the union is 68, which is the whole reason the slide stopped
naming one. The four new assertions over run 3 are the last four below: a
cell-wide buddy roster, a fresh broadcast to buyers already queued when someone
new joins, and that the positions in that broadcast are quantized rather than
exact.

`locationSource: edge` again, from miniflare's cached `cf` — cell `9q8yyk`, the
same rung run 3 recorded.

Output, 2026-09-27, on `feature/issue-34` merged with `main` at `83adc72`. The
later `main` commits pulled in after this run touched only the deck and the
ledger, not `scripts/smoke.mjs`, and the run was repeated on the final tree with
the same result:

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":4,"demoPairing":false}
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
PASS  an unusable coordinate is refused rather than relocated
PASS  welcome carries a cell — 9q8znb
PASS  welcome carries the authenticated identity — {"id":"smoke-user-robb","name":"Robb"}
PASS  welcome names the rung that placed the socket — client
PASS  first buyer queues — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  both buyers matched — aa167288-a8c4-4c8a-801d-75dcdad8525b / aa167288-a8c4-4c8a-801d-75dcdad8525b
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer QRMYEU
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — QRMYEU vs aa167288-a8c4-4c8a-801d-75dcdad8525b
PASS  distant buyer waits alone — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  survivor told their bud left
PASS  survivor requeued — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  handshake pair matched on their own deal — orderer/receiver
PASS  a wrong code is rejected — bad_pickup_code
PASS  a receiver cannot confirm with no code at all — bad_pickup_code
PASS  a wrong code completes nothing
PASS  a wrong code confirms nothing
PASS  both sides see the receiver confirm — receiver/receiver
PASS  the orderer is still owed a confirmation — orderer
PASS  a dispute deadline is armed on the half-confirmed match — 1790553266592
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — ea937a98-a30a-4ca3-96df-7af90f9b666c
PASS  completion is stamped — 1790552967212
PASS  the settled split is written to the ledger — {"match_id":"ea937a98-a30a-4ca3-96df-7af90f9b666c","deal_id":"wendys-nuggets-20","cell":"9q8znb","party_size":2,"total_collected_cents":948,"cogs_cents":849,"platform_fee_cents":99,"distance_meters":14.17211798152305,"created_at":1790552965375,"settled_at":1790552967212}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":474},{"role":"receiver","pay_cents":474}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"3490f1ba-fcee-4033-9217-cee38c08e16f","confirmedBy":"receiver","reason":"buddy_left"}
PASS  a disputed match never settles
PASS  a disputed match does not quietly requeue the survivor
PASS  a disputed match is never booked — []
PASS  a disputed match cannot be confirmed away — not_matched
PASS  a socket with no coordinates still resolves a cell — 9q8yyk
PASS  and says which rung placed it, never claiming an exact fix — edge — 'edge' when request.cf carries coordinates, 'demo' when it does not
PASS  two buyers who never shared their location pair anyway — 0cbda744-24dd-4fa0-90c2-6a7910fe6c3d / 0cbda744-24dd-4fa0-90c2-6a7910fe6c3d
PASS  the split is the same as any other pairing on this deal — 474/474 vs 474
PASS  distance is measured from the server-resolved origin — 0m
PASS  garbage rejected — bad_message
PASS  confirming without a match is refused — not_matched
PASS  unknown deal rejected over ws — [{"type":"error","code":"bad_message","message":"could not parse message"},{"type":"error","code":"not_matched","message":"you are not in a match to confirm"},{"type":"error","code":"unknown_deal","message":"no such deal: no-such-deal"}]
PASS  buddy roster is cell-wide, not scoped to one deal — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[{"lat":37.79576895436579,"lng":-122.39400304369208}]}
PASS  a buyer already queued gets a fresh roster broadcast when someone new joins the cell — 5 -> 6
PASS  the broadcast roster carries a position for the newcomer — [{"lat":37.79576895436579,"lng":-122.39400304369208}]
PASS  the broadcast never carries an exact coordinate for anyone else — [{"lat":37.79576895436579,"lng":-122.39400304369208}]
ALL CHECKS PASSED
```

`pnpm test:e2e` was run against the same server and passed both specs. That suite
is a separate lane from this file: it drives the browser rather than the raw
socket, and its count is not a deck figure.

## Run 5 — `feature/issue-28` reconciled against `main` (incl. the unpinned deck), full local stack

```bash
pnpm dev --port 5199         # in one shell
pnpm smoke                   # in another
```

Taken on the reconciled tree: the merge commit only moves document and deck
tests, so this identical harness output stands for it. The app is now
McDonald's-only here, and the count the slide no longer prints is whatever
`pnpm smoke` prints; it printed 66 passes, all of them:

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
```

Recorded as **Run 3** on `main`, and renumbered to 5 here: this document and the
promptless-location branch each independently wrote a "Run 3", and the merge had
to order them. The transcripts settle it — the ledger timestamps in this run
(`created_at: 1790553446705`) fall after those in runs 3 and 4
(`1790550157401`, `1790552965375`), so it was taken last. Nothing measured was
changed; the transcript above is byte-identical to `main`'s, wrapped in a code
fence it was missing so that it renders as a transcript rather than a paragraph.

## Run 6 — this branch merged with `main`'s McDonald's-only gate, full local stack

```bash
pnpm dev --port 5229                          # in one shell
BASE=http://localhost:5229 pnpm smoke         # in another
```

Port 5229 rather than 5199 because other dev servers were up on this machine;
`BASE` is the knob, and the sole listener on 5229 was confirmed to have this
worktree as its cwd before any of this was trusted.

The first run on a tree that has both the promptless-location work (run 3) and
`main`'s deal gate (run 5) in it. That merge is why this run had to be taken at
all: `git merge-tree` reported `scripts/smoke.mjs` as auto-merging with no
conflict marker, and the merged script was broken anyway — three scenarios,
including the promptless pair, still paired on `wendys-nuggets-20`, which the
gate now refuses on the pairing path. Run on the raw auto-merge, the suite died
at `Kai: timed out waiting for waiting`. Every scenario is on `mcd-nuggets-20`
now and isolates itself by cell and distance instead of by deal id.

74, then, and not comparable to any earlier number in either direction: the gate
added four checks on `main`'s side, the roster broadcast added four on this
side, and one more went in here to hold the promptless pair's isolation honest
(`a buyer the server placed has the cell it placed them in to themselves`).
`countSmokeChecks()`, `grep -c 'check('` and `grep -o 'check('` all read 74, and
74 `PASS` lines came out. Still nothing on a slide.

`locationSource: edge` again, from miniflare's cached `cf` — cell `9q8yyk`, the
same rung runs 3 and 4 recorded.

Output, 2026-09-27, on `feature/issue-34` merged with `main` at `b4c0848`:

```
PASS  health ok — {"ok":true,"service":"nuggbudz","protocol":4,"demoPairing":false}
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
PASS  an unusable coordinate is refused rather than relocated
PASS  welcome carries a cell — 9q8znb
PASS  welcome carries the authenticated identity — {"id":"smoke-user-robb","name":"Robb"}
PASS  welcome names the rung that placed the socket — client
PASS  first buyer queues — {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  both buyers matched — a6b33bc1-f571-43d7-b859-2554ddf861f5 / a6b33bc1-f571-43d7-b859-2554ddf861f5
PASS  roles are complementary — orderer/receiver
PASS  longest waiter orders
PASS  each pays $4.49
PASS  each owed 10pc
PASS  each saves $2.50
PASS  buddy names come from the session, not the join message — Dana/Robb
PASS  distance is a short walk — 43m
PASS  only the orderer is given the pickup code — orderer HBQ5AG
PASS  the receiver is not given the pickup code — null
PASS  pickup code is not derived from the match id — HBQ5AG vs a6b33bc1-f571-43d7-b859-2554ddf861f5
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
PASS  a dispute deadline is armed on the half-confirmed match — 1790555399797
PASS  one side confirming does not settle
PASS  a second confirmation from the same side is refused — already_confirmed
PASS  both sides get the same completion — 69d680b5-3096-49fe-81f9-5972fea38658
PASS  completion is stamped — 1790555100414
PASS  the settled split is written to the ledger — {"match_id":"69d680b5-3096-49fe-81f9-5972fea38658","deal_id":"mcd-nuggets-20","cell":"9q9p3w","party_size":2,"total_collected_cents":898,"cogs_cents":799,"platform_fee_cents":99,"distance_meters":14.166510726194598,"created_at":1790555098585,"settled_at":1790555100414}
PASS  both halves are booked, and they sum to the total — [{"role":"orderer","pay_cents":449},{"role":"receiver","pay_cents":449}]
PASS  an abandoned match is never booked — []
PASS  a settled match cannot be confirmed again — not_matched
PASS  a bud who leaves after one confirmation raises a dispute — {"type":"pickup_disputed","matchId":"88e9452a-f6fe-420a-8b71-a62d5949d22a","confirmedBy":"receiver","reason":"buddy_left"}
PASS  a disputed match never settles
PASS  a disputed match does not quietly requeue the survivor
PASS  a disputed match is never booked — []
PASS  a disputed match cannot be confirmed away — not_matched
PASS  a socket with no coordinates still resolves a cell — 9q8yyk
PASS  and says which rung placed it, never claiming an exact fix — edge — 'edge' when request.cf carries coordinates, 'demo' when it does not
PASS  a buyer the server placed has the cell it placed them in to themselves — 9q8yyk {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  two buyers who never shared their location pair anyway — 5c593969-9eeb-44a2-83b3-26d386ebd069 / 5c593969-9eeb-44a2-83b3-26d386ebd069
PASS  the split is the same as any other pairing on this deal — 449/449 vs 449
PASS  distance is measured from the server-resolved origin — 0m
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

The promptless pair is the one scenario that cannot choose its cell, so it was
also run on the other rung it can land on. Deleting `latitude`/`longitude` from
`node_modules/.mf/cf.json` and restarting put it on the demo origin instead, and
all 74 still passed:

```
PASS  a socket with no coordinates still resolves a cell — 9q8znb
PASS  and says which rung placed it, never claiming an exact fix — demo — 'edge' when request.cf carries coordinates, 'demo' when it does not
PASS  a buyer the server placed has the cell it placed them in to themselves — 9q8znb {"type":"waiting","waiting":1,"queuedAhead":0,"buddies":[]}
PASS  two buyers who never shared their location pair anyway — ed1e01c1-ef52-4b33-9001-f62cbb2d0f19 / ed1e01c1-ef52-4b33-9001-f62cbb2d0f19
PASS  the split is the same as any other pairing on this deal — 449/449 vs 449
PASS  distance is measured from the server-resolved origin — 0m
```

That rung is the one that needed the isolation fix: the demo origin's cell is
`9q8znb`, the same cell the opening pair is placed in, so the survivor left
queued there had to be dequeued first. With that one `b.ws.close()` removed, this
rung goes red — Kai is matched with Dana on the spot and never reaches `waiting`
— while the `edge` rung above stays green either way. `cf.json` was restored
byte-identically afterwards (`cmp` clean).

`pnpm test:e2e` was run against the same server (`E2E_PORT=5229`) and passed both
specs. That suite is a separate lane from this file: it drives the browser rather
than the raw socket, and its count is not a deck figure.

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

Two merges since then are the clinching data points. First `main` read 61 and the
promptless-location branch read 64, each correct against its own tree, and the
union turned out to be 68 — a number neither branch could have typed. Then `main`
moved on to 66 with the McDonald's-only gate while this branch sat at 68, and the
union of *those* is 74. The count is measured, never chosen, which is exactly why
it does not belong on a slide.

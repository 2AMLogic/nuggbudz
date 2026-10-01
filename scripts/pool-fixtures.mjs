/**
 * The coordinate table behind every live-pairing fixture in this repo — both
 * `scripts/smoke.mjs` (the raw-protocol lane) and `e2e/` (the browser lane) —
 * pulled out into one side-effect-free module.
 *
 * Why this file exists (issue #80): on PR #73, a Judge merged `origin/main` into
 * a feature branch and, while reconciling, found a hazard `git` never reports —
 * two *unrelated* scenarios' fixtures sat at byte-identical coordinates, so they
 * landed in the same `NuggPool` Durable Object and silently defeated the
 * isolation every scenario's own comments claim. A later rebase resolved the same
 * conflict worse and put the collision back, and nothing in CI caught it: two
 * scenarios sharing a market is a *race* between them, not a git conflict, a type
 * error, a lint finding, or even a reliable `pnpm smoke` failure.
 *
 * Why the unit changed (issue #82): isolation used to come from the geohash cell,
 * because the cell was the market. It is not any more — the market is
 * `MATCH_RADIUS_METERS`, and the cell is only the shard that radius is evaluated
 * in (~156 km across at precision 3). So "distinct cells" no longer means
 * isolated, and **isolation is now by distance**: every scenario sits in a
 * *market*, one metro area, and every market is more than a hundred kilometres
 * from every other one. `test/fixture-separation.test.ts` derives that from this
 * table and the repo's own `distanceMeters`, so it cannot be satisfied by
 * widening a list of exceptions.
 *
 * Distance is also the *only* isolation mechanism (issue #57). Never separate two
 * scenarios by giving them different deal ids, merchants or sauces: that couples
 * the suite to `shared/deals.ts`, and it broke `main` twice in one afternoon — a
 * branch that gated pairing to one chain, and a branch whose fixtures used a
 * second and third chain id to keep buyers apart, merged with no conflict,
 * textually clean and green in `vitest`, then died at runtime in `pnpm smoke`
 * ("timed out waiting for waiting"). The catalogue is a product decision that
 * will keep changing; a hundred kilometres will not.
 *
 * The one market distance cannot reach (issue #96): a socket that sends no
 * coordinates is placed by the server, so every `serverResolved` scenario shares
 * `DEMO_ORIGIN` and declares `fixtures: []`. Those are isolated *in time* rather
 * than in space, and `LANES` below is the table that says by what — a check with
 * nothing to examine used to be reported as a check that passed.
 */

/** @typedef {{ lat: number, lng: number }} LatLng */

/**
 * How far apart two markets must be, centre to centre.
 *
 * 100 km, which is roughly thirty times the two-mile match radius. The margin is
 * deliberately enormous relative to the rule it protects: the radius is a product
 * decision that will be tuned, and a fixture table that has to be re-derived
 * every time somebody tries 3 miles is a table nobody will keep honest.
 * `test/fixture-separation.test.ts` asserts the relationship to the real radius
 * rather than trusting this comment.
 */
export const MIN_MARKET_SEPARATION_METERS = 100_000

/**
 * How far a fixture may sit from the centre of the market it belongs to.
 *
 * Keeps a market label honest — a fixture drifting out of its metro would still
 * pass the separation check while quietly ending up next door to another
 * scenario. With the separation above, this also bounds the worst case: two
 * fixtures in different markets are at least 100 - 15 - 15 = 70 km apart.
 */
export const MAX_MARKET_SPAN_METERS = 15_000

/**
 * One metro area per scenario, because the metro *is* the isolation.
 *
 * `serverResolved` is the odd one out and the reason every other market is
 * somewhere else entirely: a socket that sends no coordinates is placed by the
 * server, from `request.cf` when the runtime has one and from
 * `DEMO_ORIGIN` (`shared/location.ts`) when it does not — both of which are in
 * San Francisco. Nothing can choose where those sockets land, so the whole Bay
 * Area is reserved for them and no explicitly-placed fixture may come within the
 * separation distance of it.
 */
export const MARKETS = {
  serverResolved: {
    // DEMO_ORIGIN, duplicated here because this module must stay importable from
    // plain Node (`scripts/smoke.mjs`) where `shared/location.ts` is not. The
    // separation test asserts the two agree.
    lat: 37.7955,
    lng: -122.3937,
    label: 'San Francisco — reserved for sockets the server places itself',
  },
  sacramento: { lat: 38.5816, lng: -121.4944, label: 'Sacramento' },
  portland: { lat: 45.5152, lng: -122.6784, label: 'Portland' },
  lasVegas: { lat: 36.1699, lng: -115.1398, label: 'Las Vegas' },
  phoenix: { lat: 33.4484, lng: -112.074, label: 'Phoenix' },
  austin: { lat: 30.2676, lng: -97.7433, label: 'Austin' },
  denver: { lat: 39.7392, lng: -104.9903, label: 'Denver' },
  dallas: { lat: 32.7767, lng: -96.797, label: 'Dallas' },
  seattle: { lat: 47.6062, lng: -122.3321, label: 'Seattle' },
  brooklyn: { lat: 40.6782, lng: -73.9442, label: 'Brooklyn' },
  chicago: { lat: 41.8781, lng: -87.6298, label: 'Chicago' },
  losAngeles: { lat: 34.0522, lng: -118.2437, label: 'Los Angeles' },
  philadelphia: { lat: 39.9526, lng: -75.1652, label: 'Philadelphia' },
  nashville: { lat: 36.1627, lng: -86.7816, label: 'Nashville' },
  atlanta: { lat: 33.749, lng: -84.388, label: 'Atlanta' },
  boston: { lat: 42.3601, lng: -71.0589, label: 'Boston' },
  pittsburgh: { lat: 40.4406, lng: -79.9959, label: 'Pittsburgh' },
  minneapolis: { lat: 44.9778, lng: -93.265, label: 'Minneapolis' },
  houston: { lat: 29.7604, lng: -95.3698, label: 'Houston' },
  miami: { lat: 25.7617, lng: -80.1918, label: 'Miami' },
  saltLakeCity: { lat: 40.7608, lng: -111.891, label: 'Salt Lake City' },
  detroit: { lat: 42.3314, lng: -83.0458, label: 'Detroit' },
  albuquerque: { lat: 35.0844, lng: -106.6504, label: 'Albuquerque' },
  kansasCity: { lat: 39.0997, lng: -94.5786, label: 'Kansas City' },
  stLouis: { lat: 38.627, lng: -90.1994, label: 'St. Louis' },
  elPaso: { lat: 31.7619, lng: -106.485, label: 'El Paso' },
  oklahomaCity: { lat: 35.4676, lng: -97.5164, label: 'Oklahoma City' },
  tulsa: { lat: 36.154, lng: -95.9928, label: 'Tulsa' },
  memphis: { lat: 35.1495, lng: -90.049, label: 'Memphis' },
  indianapolis: { lat: 39.7684, lng: -86.1581, label: 'Indianapolis' },
}

/**
 * Every fixture coordinate in the repo, derived from its market's centre.
 *
 * The literals are absolute rather than computed at import time so that a
 * coordinate is greppable and a diff is readable, but they were generated by
 * offsetting the market centre by a stated number of metres, and the distances
 * each scenario depends on are re-derived and asserted in
 * `test/fixture-separation.test.ts` rather than trusted from a comment.
 *
 * @type {Record<string, LatLng>}
 */
export const FIXTURE_COORDS = {
  // The opening pair: two buyers 40 m apart, who must match.
  robb: { lat: 38.5816, lng: -121.4944 },
  dana: { lat: 38.581723, lng: -121.493968 },
  // 5 km north of them: same shard, same deal, beyond the match radius.
  far: { lat: 38.626566, lng: -121.4944 },
  // The pickup-handshake pair, 15 m apart.
  gus: { lat: 45.5152, lng: -122.6784 },
  hana: { lat: 45.515295, lng: -122.678264 },
  // The one-sided-confirmation-then-abandonment (dispute) pair.
  ivy: { lat: 36.1699, lng: -115.1398 },
  jed: { lat: 36.169995, lng: -115.139682 },
  // The roster-broadcast scenario. `kim` and `kimTab` are two sockets of the
  // *same* account 40 m apart: since #101 the second one is **refused**, not
  // queued beside the first, which is what makes them the fixture for that
  // refusal rather than for the roster. `lee` is a different account exactly
  // three miles east — same shard, outside the radius, invisible to everyone
  // here. `moss` matches kim and then walks away, which requeues kim beside
  // `nell`: two queued buyers inside one radius who are not each other's
  // candidates, which after #101 is the only way that arrangement can arise.
  kim: { lat: 33.4484, lng: -112.074 },
  kimTab: { lat: 33.448277, lng: -112.073595 },
  lee: { lat: 33.4484, lng: -112.021962 },
  moss: { lat: 33.44876, lng: -112.074 },
  nell: { lat: 33.4484, lng: -112.073568 },
  // Nuggchat: two live matches and a fifth buyer queued alone, all in one market.
  chatA: { lat: 30.2676, lng: -97.7433 },
  chatB: { lat: 30.267708, lng: -97.7433 },
  chatC: { lat: 30.267816, lng: -97.7433 },
  chatD: { lat: 30.267924, lng: -97.7433 },
  chatE: { lat: 30.268032, lng: -97.7433 },
  // The chat channel closing on a dispute, and on a buddy walking away.
  chatDisputeOne: { lat: 39.7392, lng: -104.9903 },
  chatDisputeTwo: { lat: 39.739395, lng: -104.990154 },
  chatLeaveOne: { lat: 32.7767, lng: -96.797 },
  chatLeaveTwo: { lat: 32.776895, lng: -96.796866 },
  // The sustained-flood-against-a-just-disputed-match pair (issue #120): the
  // orderer vanishes right after the receiver confirms, and the receiver
  // floods immediately rather than waiting for `pickup_disputed` — waiting
  // would mean this connection's own status has already dropped out of
  // `matched` by the time the flood starts.
  chatFloodOne: { lat: 31.7619, lng: -106.485 },
  chatFloodTwo: { lat: 31.762095, lng: -106.484876 },
  // The bystander who holds a real pickup code and is not in that match. Stands
  // 15 m from `gus`, in the handshake pair's own market and therefore in their
  // own Durable Object — the point of the probe is that the server refuses them
  // for who they are, not because the match is somewhere else. Never joins.
  bystander: { lat: 45.515295, lng: -122.678536 },
  // The sauce-preference pair.
  sal: { lat: 47.6062, lng: -122.3321 },
  nia: { lat: 47.606295, lng: -122.331959 },
  // Liveness scenarios, each in a market of its own so none of them can be
  // pulled into a match by anything else in the table.
  pinger: { lat: 40.6782, lng: -73.9442 },
  stale: { lat: 41.8781, lng: -87.6298 },
  slowOne: { lat: 34.0522, lng: -118.2437 },
  slowTwo: { lat: 34.052295, lng: -118.243585 },
  halfOne: { lat: 39.9526, lng: -75.1652 },
  halfTwo: { lat: 39.952695, lng: -75.165076 },
  // The regression guard for issue #82: a mile and a half apart, which put them
  // in *different* geohash-6 cells. Under the old sharding they could never have
  // seen each other however close they stood to the boundary; they must match.
  mia: { lat: 36.1627, lng: -86.7816 },
  theo: { lat: 36.1627, lng: -86.75471 },
  // The payment-gate lane (`scripts/payment-gate-check.mjs`), which drives the
  // same dev server as `pnpm smoke` and so needs the same separation.
  payHere: { lat: 40.4406, lng: -79.9959 },
  payNearby: { lat: 40.440723, lng: -79.995518 },
  // The charged-dispute triples (`scripts/payment-gate-check.mjs`, issue #100):
  // three pairs, each driven to a dispute in turn and each fed to a different
  // operator resolution (`refund_receiver`, `voided`, a refused refund). Only
  // one pair is ever live at once — each socket closes before the next pair
  // opens — so all three reuse this one 40 m-apart coordinate pair rather than
  // needing six distinct points. Its own market, because the payment-gate lane
  // already owns `pittsburgh` for the unrelated charged-path scenarios above.
  disputeHere: { lat: 38.627, lng: -90.1994 },
  disputeNearby: { lat: 38.627323, lng: -90.199018 },
  // The honeypot lane (`scripts/honeypot-check.mjs`). Two buyers 40 m apart who
  // are never live at the same time: each opens, is paired with a *decoy*, tears
  // that match down and closes before the next one opens. They need a market of
  // its own for a sharper reason than most — the whole assertion is "this buyer
  // had nobody real to pair with", so a stray buyer from a neighbouring scenario
  // would not add noise, it would make the check pass for the wrong reason by
  // pairing them with a person. Memphis rather than Oklahoma City because #150
  // landed `browseAnon`/`browseSeated` on that exact coordinate while this
  // branch was open — see the merge comment on PR #157.
  honeypotSolo: { lat: 35.1495, lng: -90.049 },
  honeypotProbe: { lat: 35.149623, lng: -90.048508 },
  // The requeue-after-a-bow-out pair (issue #160), also in the honeypot lane but
  // in a market of its own because — uniquely in this table — the two of them
  // are live *at the same time*. They arrive seconds apart into an empty market,
  // are each paired with a decoy (the second one because the first is already
  // `matched` and so invisible to the matcher), and must pair with *each other*
  // once both decoys have excused themselves. A stray buyer from a neighbouring
  // scenario would pair with one of them and make that outcome unreadable, and
  // `honeypotSolo`/`honeypotProbe` cannot be reused because their whole design
  // is that only one is ever open at a time.
  honeypotPairOne: { lat: 39.7684, lng: -86.1581 },
  honeypotPairTwo: { lat: 39.768123, lng: -86.157608 },
  // The browser lane (`e2e/`). Same table, because the separation rule is about
  // which Durable Object a fixture lands in, and both lanes drive the same one.
  e2eBuddyA: { lat: 33.749, lng: -84.388 },
  e2eBuddyB: { lat: 33.749123, lng: -84.387593 },
  e2eOrla: { lat: 42.3601, lng: -71.0589 },
  e2ePace: { lat: 42.360195, lng: -71.058771 },
  e2eQuin: { lat: 42.360291, lng: -71.058642 },
  e2eMapper: { lat: 44.9778, lng: -93.265 },
  // The scanned-handoff lane (`e2e/scan.spec.ts`). Four pairs, each 40 m apart
  // like `e2eBuddyA`/`e2eBuddyB`, and each in a market of its own: every one of
  // these scenarios drives a camera through a *settled or refused* handshake, so
  // a stray buyer wandering in from a neighbouring scenario would not merely add
  // noise, it would pair with the wrong person and take the pickup code with it.
  e2eScanA: { lat: 29.7604, lng: -95.3698 },
  e2eScanB: { lat: 29.760523, lng: -95.369393 },
  e2eWrongCodeA: { lat: 25.7617, lng: -80.1918 },
  e2eWrongCodeB: { lat: 25.761823, lng: -80.191393 },
  e2eNoCameraA: { lat: 40.7608, lng: -111.891 },
  e2eNoCameraB: { lat: 40.760923, lng: -111.890593 },
  e2eUnmountA: { lat: 42.3314, lng: -83.0458 },
  e2eUnmountB: { lat: 42.331523, lng: -83.045393 },
  // The scanner chunk that will not load: `import('jsqr')` is aborted at the
  // network, which is the one camera-failure branch nothing else covers.
  e2eNoChunkA: { lat: 35.0844, lng: -106.6504 },
  e2eNoChunkB: { lat: 35.084523, lng: -106.649993 },
  // The narrow-phone QR scale lane (`e2e/qr-scale.spec.ts`). No camera in this
  // one — it screenshots the orderer's rendered symbol on a 320px viewport — but
  // it still needs a market of its own, because it pairs two browsers and holds a
  // live pickup code while it measures.
  e2eNarrowA: { lat: 39.0997, lng: -94.5786 },
  e2eNarrowB: { lat: 39.099823, lng: -94.578193 },
  // Browsing without a seat (#150): a socket with no session, welcomed and shown
  // the market, beside a signed-in buyer 40 m away whose seat is what it counts.
  // The anonymous one never holds a seat on a strict server, so nothing here can
  // pair with it — but it is still in a market of its own, because its whole
  // assertion is an exact count of who is queued within its radius.
  browseAnon: { lat: 35.4676, lng: -97.5164 },
  browseSeated: { lat: 35.467723, lng: -97.515993 },
  // The same, through the browser (`e2e/late-sign-in.spec.ts`): the signed-out
  // page reads the count off the screen and is asked to sign in when it taps.
  e2eBrowseAnon: { lat: 36.154, lng: -95.9928 },
  e2eBrowseSeated: { lat: 36.154123, lng: -95.992393 },
}

// The "Protocol hygiene" socket (BUYERS.bad) deliberately reuses `robb`'s
// coordinate *object* rather than a copied literal, so the two can never quietly
// drift apart — the whole point of this fixture is that it reopens a socket in
// the market `robb` and `dana` just vacated. Declared below.
FIXTURE_COORDS.badRejoin = FIXTURE_COORDS.robb

/**
 * What runs each lane, and what keeps two of its scenarios from being live at the
 * same time.
 *
 * Distance isolates every scenario that owns a coordinate — which is all of them
 * but one market. Nothing can choose where a *promptless* socket lands, so every
 * `serverResolved` scenario sits on `DEMO_ORIGIN` together, with `fixtures: []`
 * and nothing for a distance check to measure. Until issue #96 that absence was
 * reported as a pass: every check in `test/fixture-separation.test.ts` iterates
 * fixtures, so a scenario with none was *missing* from all of them, and a missing
 * check reads in the output exactly like one that ran and found nothing wrong.
 *
 * Those scenarios are isolated **in time** instead, and this table is what says
 * how. `runners` are the commands as `.github/workflows/ci.yml` invokes them,
 * because the job graph is what actually decides who can be live together: steps
 * inside one job run in sequence, and two jobs are two runners on two machines
 * with a dev server each. The separation test resolves every command against that
 * workflow rather than trusting this table, so a lane whose runner CI stopped
 * calling fails instead of going quiet.
 *
 * `serializer` is the second mechanism, needed only where one lane drives more
 * than one `serverResolved` scenario — then the job graph does not separate them
 * and the runner itself has to, so the claim names the file that makes it and is
 * checked against that file's source. If a lane ever needs one because two of its
 * *different* runners drive fixture-less scenarios, split the lane rather than
 * declaring a serializer neither runner implements.
 *
 * @type {Record<string, { runners: string[],
 *                         serializer: { file: string, claim: string, why: string } | null }>}
 */
export const LANES = {
  smoke: {
    runners: ['pnpm smoke'],
    serializer: null,
  },
  e2e: {
    runners: ['pnpm test:e2e'],
    serializer: {
      file: 'playwright.config.ts',
      claim: 'workers: 1',
      why:
        'Several `serverResolved` specs share the one `e2e` job, and so share the one dev server ' +
        'its webServer boots — the job graph cannot separate them. Playwright running on a ' +
        'single worker is what does. Raise that to 2 and two promptless specs queue buyers in ' +
        'the same Durable Object at the same time, which fails as a race, not as a broken test.',
    },
  },
  payments: {
    // One lane, four CI jobs: `pnpm payment-gate` runs in `smoke` (the uncharged
    // branch), `payment-gate-closed` and `payment-gate-live`; the other two have a
    // job each. All three are foreground steps, which is what keeps them apart
    // from each other and from `pnpm smoke` inside the job they share.
    runners: ['pnpm payment-gate', 'pnpm demo-check', 'pnpm honeypot-check'],
    serializer: null,
  },
}

/**
 * Which fixtures belong to which scenario, and which market each scenario owns.
 *
 * `lane` says which runner drives it, so a failure names a file a reader can
 * open — and, for a scenario with no fixtures, it is the *whole* isolation story:
 * see `LANES` above. Two scenarios may share a market only when they are
 * deliberately in one market (the opening pair and the socket that rejoins its
 * market after it empties); everything else gets a metro to itself.
 *
 * @type {Record<string, { lane: keyof typeof LANES, market: string,
 *                          fixtures: string[], what: string }>}
 */
export const SCENARIOS = {
  openingPair: {
    lane: 'smoke',
    market: 'sacramento',
    fixtures: ['robb', 'dana'],
    what: 'two buyers on the same block pair, split evenly and get complementary roles',
  },
  distantBuyer: {
    lane: 'smoke',
    market: 'sacramento',
    fixtures: ['far'],
    what: 'a buyer in the same shard but outside the radius is not matched',
  },
  protocolHygiene: {
    lane: 'smoke',
    market: 'sacramento',
    fixtures: ['badRejoin'],
    what: 'garbage frames, forged confirmations and gated deals are refused',
  },
  handshakePair: {
    lane: 'smoke',
    market: 'portland',
    fixtures: ['gus', 'hana', 'bystander'],
    what:
      'the two-sided pickup handshake settles to the ledger, and a third socket holding the ' +
      'real code settles nothing because it is not the receiver of that match',
  },
  disputePair: {
    lane: 'smoke',
    market: 'lasVegas',
    fixtures: ['ivy', 'jed'],
    what: 'one side confirming alone times out into a dispute',
  },
  rosterBroadcast: {
    lane: 'smoke',
    market: 'phoenix',
    fixtures: ['kim', 'kimTab', 'lee', 'moss', 'nell'],
    what:
      'the map roster is radius-scoped, a newcomer refreshes it for everyone nearby, and a ' +
      'second tab of one identity is refused rather than queued beside the first',
  },
  boundaryStraddle: {
    lane: 'smoke',
    market: 'nashville',
    fixtures: ['mia', 'theo'],
    what: 'a mile and a half apart across a geohash-6 boundary still pairs (#82)',
  },
  chatRelay: {
    lane: 'smoke',
    market: 'austin',
    fixtures: ['chatA', 'chatB', 'chatC', 'chatD', 'chatE'],
    what: 'chat reaches one buddy, is stored nowhere, and never crosses matches',
  },
  chatDispute: {
    lane: 'smoke',
    market: 'denver',
    fixtures: ['chatDisputeOne', 'chatDisputeTwo'],
    what: 'the chat channel closes when a match is disputed',
  },
  chatLeave: {
    lane: 'smoke',
    market: 'dallas',
    fixtures: ['chatLeaveOne', 'chatLeaveTwo'],
    what: 'the chat channel closes, and clears, when a buddy walks away',
  },
  chatFloodAfterTerminal: {
    lane: 'smoke',
    market: 'elPaso',
    fixtures: ['chatFloodOne', 'chatFloodTwo'],
    what:
      'a sustained flood against a match that just left `pending` is refused as a rate limit, ' +
      'not as "not matched" (#120)',
  },
  saucePair: {
    lane: 'smoke',
    market: 'seattle',
    fixtures: ['sal', 'nia'],
    what: 'sauce ids off a socket are validated against the joined deal’s menu',
  },
  pingerLiveness: {
    lane: 'smoke',
    market: 'brooklyn',
    fixtures: ['pinger'],
    what: 'a ping keeps a queued buyer’s seat alive',
  },
  staleLiveness: {
    lane: 'smoke',
    market: 'chicago',
    fixtures: ['stale'],
    what: 'a buyer who goes quiet is warned, then dropped',
  },
  unconfirmedExpiryPair: {
    lane: 'smoke',
    market: 'losAngeles',
    fixtures: ['slowOne', 'slowTwo'],
    what: 'a match neither side confirms is cancelled for both',
  },
  halfConfirmedBoundaryPair: {
    lane: 'smoke',
    market: 'philadelphia',
    fixtures: ['halfOne', 'halfTwo'],
    what: 'a half-confirmed match belongs to the dispute timer, not the expiry sweep',
  },
  paymentGatePair: {
    lane: 'payments',
    market: 'pittsburgh',
    fixtures: ['payHere', 'payNearby'],
    what: 'no pickup code is issued until both halves of a match have paid',
  },
  promptlessPair: {
    lane: 'smoke',
    market: 'serverResolved',
    fixtures: [],
    what: 'two buyers who never send a coordinate are placed by the server and pair anyway',
  },
  chargedDisputePair: {
    lane: 'payments',
    market: 'stLouis',
    fixtures: ['disputeHere', 'disputeNearby'],
    what:
      'a charged dispute holds the full total, and an operator resolution refunds exactly the ' +
      'right leg — the receiver alone, both, or none when Stripe refuses',
  },
  honeypotFallback: {
    lane: 'payments',
    market: 'memphis',
    fixtures: ['honeypotSolo', 'honeypotProbe'],
    what:
      'a buyer alone in a market is paired with a decoy that can never be charged, never ' +
      'releases a code, answers a line of chat and then excuses itself through the refunding ' +
      'teardown — leaving no matches, disputes, holds or reputation row behind',
  },
  honeypotRequeuePair: {
    lane: 'payments',
    market: 'indianapolis',
    fixtures: ['honeypotPairOne', 'honeypotPairTwo'],
    what:
      'two buyers each stood up by a decoy are paired with each other the moment the second ' +
      'bow-out requeues them, rather than both waiting for a third person who never comes (#160)',
  },
  e2ePair: {
    lane: 'e2e',
    market: 'atlanta',
    fixtures: ['e2eBuddyA', 'e2eBuddyB'],
    what: 'two browsers pair, split the box and see complementary roles on screen',
  },
  e2eRequeue: {
    lane: 'e2e',
    market: 'boston',
    fixtures: ['e2eOrla', 'e2ePace', 'e2eQuin'],
    what: 'a buyer whose bud walks away is requeued, and the transcript is cleared',
  },
  e2eMapTiles: {
    lane: 'e2e',
    market: 'minneapolis',
    fixtures: ['e2eMapper'],
    what: 'the map draws real basemap tiles rather than a constant placeholder',
  },
  e2eScannedHandoff: {
    lane: 'e2e',
    market: 'houston',
    fixtures: ['e2eScanA', 'e2eScanB'],
    what: 'a code read off the orderer’s screen by a camera settles the match',
  },
  e2eWrongCodeScan: {
    lane: 'e2e',
    market: 'miami',
    fixtures: ['e2eWrongCodeA', 'e2eWrongCodeB'],
    what: 'a scanned QR carrying another match’s code is refused, and typing still settles',
  },
  e2eNoCameraHandoff: {
    lane: 'e2e',
    market: 'saltLakeCity',
    fixtures: ['e2eNoCameraA', 'e2eNoCameraB'],
    what: 'a refused camera still completes the handoff by typing the code',
  },
  e2eCameraUnmount: {
    lane: 'e2e',
    market: 'detroit',
    fixtures: ['e2eUnmountA', 'e2eUnmountB'],
    what: 'the camera stream is stopped when the receipt holding it goes away',
  },
  e2eNativeHandoff: {
    lane: 'e2e',
    market: 'serverResolved',
    fixtures: [],
    what:
      'the handoff link opened in a second tab carries the receiver into the same match — ' +
      'promptlessly, because a second tab has no coordinates of its own to send and the ' +
      'server-resolved shard is the one a real demo pairs in',
  },
  e2eNarrowQr: {
    lane: 'e2e',
    market: 'kansasCity',
    fixtures: ['e2eNarrowA', 'e2eNarrowB'],
    what:
      'the pickup QR is drawn at whole pixels per module and is never resampled by the ' +
      'browser, measured off a screenshot of the composited element on a 320px viewport',
  },
  e2eScannerChunkFails: {
    lane: 'e2e',
    market: 'albuquerque',
    fixtures: ['e2eNoChunkA', 'e2eNoChunkB'],
    what: 'a decoder chunk that will not load is reported, and typing still settles',
  },
  e2eRefusedPrompt: {
    lane: 'e2e',
    market: 'serverResolved',
    fixtures: [],
    what: 'a refused location prompt still pairs, placed by the server',
  },
  browseOnly: {
    lane: 'smoke',
    market: 'oklahomaCity',
    fixtures: ['browseAnon', 'browseSeated'],
    what:
      'a socket with no session is welcomed, counted the market within its radius and never ' +
      'sent the roster, and is refused a seat on the wire rather than paired (#150)',
  },
  e2eLateSignIn: {
    lane: 'e2e',
    market: 'tulsa',
    fixtures: ['e2eBrowseAnon', 'e2eBrowseSeated'],
    what:
      'a signed-out page sees the count waiting within its radius, and tapping for a seat ' +
      'brings up the sign-in interstitial instead of a queue (#150)',
  },
  e2eLateSignInResume: {
    lane: 'e2e',
    market: 'serverResolved',
    fixtures: [],
    what:
      'back from the sign-in round trip, the buyer takes the seat they were taking with the ' +
      'deal and sauces they chose — placed by the server, since a precise fix is not carried',
  },
  demoCheckPair: {
    lane: 'payments',
    market: 'serverResolved',
    fixtures: [],
    what: 'two demo clients with no accounts and no coordinates pair on stage',
  },
}

/**
 * The in-market relationships a scenario's outcome depends on.
 *
 * Two fixtures in one market are expected to be *within* the match radius of
 * each other — that is what putting them in one market means. Every exception to
 * that is named here with a reason, and `test/fixture-separation.test.ts` asserts
 * each one still holds: a stale entry claiming a separation the coordinates no
 * longer have fails just as loudly as an undeclared one.
 *
 * @type {{ fixtures: [string, string],
 *          relation: 'within-radius' | 'beyond-radius' | 'same-point',
 *          straddlesFineCell?: boolean, why: string }[]}
 */
export const MARKET_RELATIONS = [
  {
    fixtures: ['robb', 'far'],
    relation: 'beyond-radius',
    why:
      '`far` is the check that the radius, not the shard, decides a match: same shard as the ' +
      'opening pair, same deal, five kilometres away, and therefore never matched with them.',
  },
  {
    fixtures: ['dana', 'far'],
    relation: 'beyond-radius',
    why: 'Same reason as robb/far — `far` must be out of range of *both* halves of that pair.',
  },
  {
    fixtures: ['badRejoin', 'robb'],
    relation: 'same-point',
    why:
      'The protocol-hygiene socket deliberately reopens in the opening pair’s market once both ' +
      'of its sockets have closed, which is why it shares the coordinate object rather than ' +
      'copying the literal. This is the one intentional coordinate collision in the table; ' +
      'every other one is a bug.',
  },
  {
    fixtures: ['badRejoin', 'far'],
    relation: 'beyond-radius',
    why:
      '`badRejoin` sits on `robb`, so the same five kilometres separate it from `far`. Declared ' +
      'so the alias above cannot quietly inherit a relationship nobody stated.',
  },
  {
    fixtures: ['moss', 'lee'],
    relation: 'beyond-radius',
    why:
      '`lee` is three miles from everything else in this market, `moss` included — the roster ' +
      'scoping claim is that nobody here can see them, not merely that kim cannot.',
  },
  {
    fixtures: ['nell', 'lee'],
    relation: 'beyond-radius',
    why:
      'Same reason as moss/lee. `nell` is the buyer left queued beside the requeued kim, and ' +
      'the roster both of them end up with has to be empty of `lee`.',
  },
  {
    fixtures: ['kimTab', 'lee'],
    relation: 'beyond-radius',
    why:
      '`kimTab` sits 40 m from `kim`, so the same three miles separate it from `lee`. Declared ' +
      'so the refused second tab cannot quietly inherit a relationship nobody stated.',
  },
  {
    fixtures: ['kim', 'lee'],
    relation: 'beyond-radius',
    why:
      'Exactly three miles: the acceptance criterion that two buyers a mile beyond the radius ' +
      'stay queued, and that a buyer outside it never appears on the other’s map.',
  },
  {
    fixtures: ['kimTab', 'lee'],
    relation: 'beyond-radius',
    why: 'The second tab of the same account is also out of range of `lee`, for the same reason.',
  },
  {
    fixtures: ['mia', 'theo'],
    relation: 'within-radius',
    straddlesFineCell: true,
    why:
      'A mile and a half apart and in different geohash-6 cells. Before #82 these two could ' +
      'never have been matched at any distance, because the market was the cell; now the walk ' +
      'is the only thing that decides. If a finer shard ever comes back, this pair fails first.',
  },
]

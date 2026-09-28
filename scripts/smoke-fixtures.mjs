/**
 * The coordinate table behind scripts/smoke.mjs's live-pairing scenarios,
 * pulled out into its own side-effect-free module.
 *
 * Why this file exists (issue #80): on PR #73, a Judge merged `origin/main`
 * into a feature branch and, while reconciling, found a hazard `git` never
 * reports — two *unrelated* scenarios' fixtures sat at byte-identical
 * coordinates, so they encoded to the same geohash cell and therefore the
 * same `NuggPool` Durable Object, silently defeating the per-cell isolation
 * every scenario's own comments claim. The Judge moved one of them and left
 * the fix in a merge commit. A later rebase of the same branch resolved the
 * same conflict *worse*, putting the collision back — and nothing in CI
 * caught it, because a shared cell is a race between scenarios, not a git
 * conflict, a type error, a lint finding, or even a reliable `pnpm smoke`
 * failure. The only reason it never reached `main` is that two agents in a
 * row happened to eyeball the literals.
 *
 * `test/smoke-fixture-cells.test.ts` is the mechanical replacement for that
 * eyeballing: it imports `FIXTURE_COORDS` and `SCENARIOS` from here, runs
 * every coordinate through the repo's own `geohash()` (shared/geo.ts), and
 * fails if two scenarios land in the same cell without that collision being
 * named in `SHARED_CELL_EXCEPTIONS`. scripts/smoke.mjs imports its
 * coordinates from this same table (rather than repeating the literals)
 * specifically so there is exactly one table for both the live smoke test
 * and this static check to agree on — a second, hand-copied table would
 * reintroduce the same "nobody is actually comparing the numbers" hazard
 * this file exists to remove.
 */

/** @typedef {{ lat: number, lng: number }} LatLng */

/** @type {Record<string, LatLng>} */
export const FIXTURE_COORDS = {
  // The opening pair: two buyers on the same block.
  robb: { lat: 37.7955, lng: -122.3937 },
  dana: { lat: 37.7958, lng: -122.394 },
  // Same cell region as the opening pair, but far enough to fail the distance
  // check rather than the cell check.
  far: { lat: 37.84, lng: -122.3937 },
  // The pickup-handshake pair.
  gus: { lat: 37.8715, lng: -122.273 },
  hana: { lat: 37.8716, lng: -122.2731 },
  // The one-sided-confirmation-then-abandonment (dispute) pair.
  ivy: { lat: 37.3382, lng: -121.8863 },
  jed: { lat: 37.3383, lng: -121.8864 },
  // The cell-roster-broadcast pair: DELIBERATELY the same cell as each other
  // (that is the scenario), but far enough apart that they cannot match.
  kim: { lat: 37.7108, lng: -122.3873 },
  lee: { lat: 37.7158, lng: -122.3771 },
  // The sauce-preference pair, in Seattle so nothing above can reach it.
  sal: { lat: 47.6062, lng: -122.3321 },
  nia: { lat: 47.6063, lng: -122.3322 },
  // Liveness scenarios: each isolated in its own city so none of them can be
  // pulled into a match by anything else in the table.
  pinger: { lat: 40.6782, lng: -73.9442 },
  stale: { lat: 41.8781, lng: -87.6298 },
  slowOne: { lat: 34.0522, lng: -118.2437 },
  slowTwo: { lat: 34.0523, lng: -118.2438 },
  halfOne: { lat: 39.9526, lng: -75.1652 },
  halfTwo: { lat: 39.9527, lng: -75.1653 },
}

// `badRejoin` (the "Protocol hygiene" socket, BUYERS.bad) deliberately reuses
// `robb`'s coordinate object rather than a copied literal, so the two can
// never quietly drift apart — the whole point of this fixture is that it
// lands in the *same* cell `robb` and `dana` just vacated. See
// `SHARED_CELL_EXCEPTIONS` below.
FIXTURE_COORDS.badRejoin = FIXTURE_COORDS.robb

/**
 * Which fixtures belong to which live-pairing scenario in scripts/smoke.mjs.
 * Members of the *same* scenario are expected to land in the same cell (most
 * scenarios are a pair meant to match, or — for `rosterBroadcastPair` — two
 * buyers deliberately sharing a cell to exercise the roster broadcast). What
 * must never happen without a declared exception is two *different*
 * scenarios sharing a cell.
 *
 * @type {Record<string, string[]>}
 */
export const SCENARIOS = {
  openingPair: ['robb', 'dana'],
  distantBuyer: ['far'],
  handshakePair: ['gus', 'hana'],
  disputePair: ['ivy', 'jed'],
  rosterBroadcastPair: ['kim', 'lee'],
  saucePair: ['sal', 'nia'],
  pingerLiveness: ['pinger'],
  staleLiveness: ['stale'],
  unconfirmedExpiryPair: ['slowOne', 'slowTwo'],
  halfConfirmedBoundaryPair: ['halfOne', 'halfTwo'],
  // The garbage-frame / forged-confirm checks. Deliberately reuses
  // `openingPair`'s cell — see SHARED_CELL_EXCEPTIONS.
  protocolHygiene: ['badRejoin'],
}

/**
 * The complete, named list of scenario pairs that are *allowed* to share a
 * cell despite being different scenarios. Anything not listed here that
 * collides is exactly the defect class issue #80 is guarding against: a
 * silent, undeclared collision between two scenarios that each assume they
 * have a cell to themselves.
 *
 * @type {{ name: string, scenarios: [string, string], reason: string }[]}
 */
export const SHARED_CELL_EXCEPTIONS = [
  {
    name: 'forged-rejoin',
    scenarios: ['openingPair', 'protocolHygiene'],
    reason:
      "protocolHygiene (BUYERS.bad, socket `c` in scripts/smoke.mjs's " +
      '"Protocol hygiene" section) deliberately reopens a socket in ' +
      "openingPair's cell (BUYERS.robb / BUYERS.dana) to drive the " +
      'garbage-frame, forged-confirm and gated-deal checks. Both of ' +
      "openingPair's sockets (`a` and `b`) are closed — `a.ws.close()` then " +
      '`b.ws.close()` — before this socket ever opens, so there is no live ' +
      'buyer left in that cell to collide with. This is the one deliberate ' +
      'fixture-sharing case this file knows about; every other collision ' +
      'this check finds is a bug, not a scenario.',
  },
]

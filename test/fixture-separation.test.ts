import { describe, expect, it } from 'vitest'
// scripts/pool-fixtures.mjs is a plain, side-effect-free data module — unlike
// scripts/smoke.mjs itself, importing it does not dial a dev server.
import {
  FIXTURE_COORDS,
  MARKET_RELATIONS,
  MARKETS,
  MAX_MARKET_SPAN_METERS,
  MIN_MARKET_SEPARATION_METERS,
  SCENARIOS,
} from '../scripts/pool-fixtures.mjs'
import {
  DEFAULT_MATCH_RADIUS_METERS,
  DEFAULT_POOL_CELL_PRECISION,
  distanceMeters,
  geohash,
  METERS_PER_MILE,
} from '../shared/geo'
import { DEMO_ORIGIN } from '../shared/location'
// The deployed configuration, read as text: wrangler.jsonc is JSONC, and this
// file's job is to check the numbers the Worker is actually given rather than a
// second copy of them.
import wranglerSource from '../wrangler.jsonc?raw'

/**
 * Every live-pairing fixture in this repo — `scripts/smoke.mjs` and `e2e/` — has
 * to be isolated from every other scenario's, and that claim is invisible to
 * every other check here: not a merge conflict, not a type error, not a lint
 * finding, and `vitest` never reaches the Durable Object that would notice.
 * Neither live runner catches it reliably either, because two scenarios sharing a
 * market is a *race* between them rather than a deterministic failure — the worst
 * kind of green.
 *
 * Issue #80 is the incident: two unrelated scenarios' fixtures at byte-identical
 * coordinates, fixed in a merge commit, then silently reintroduced by a rebase
 * that resolved the same conflict the other way. The only reason it never reached
 * `main` was two agents in a row happening to eyeball the literals.
 *
 * Issue #82 changed the *unit* of that isolation, which is why this file is about
 * distance and not cells. The geohash cell used to be the market, so distinct
 * cells meant isolated scenarios. The cell is now only the shard — ~156 km across
 * at precision 3 — and the market is `MATCH_RADIUS_METERS`. A cell-distinctness
 * check would now pass for fixtures sitting inside each other's circles, which is
 * exactly the reassuring-but-false green this file exists to prevent. So
 * **isolation is by distance**, derived from the fixture table and the repo's own
 * `distanceMeters` rather than from any hand-maintained list of expected cells.
 */

const scenarioNames = Object.keys(SCENARIOS)
const fixtureIds = Object.keys(FIXTURE_COORDS)
const marketNames = Object.keys(MARKETS)

/** Which market each fixture belongs to, read off the scenario table. */
const marketOf = new Map<string, string>()
for (const spec of Object.values(SCENARIOS)) {
  for (const id of spec.fixtures) marketOf.set(id, spec.market)
}

/**
 * The worst case two fixtures in different markets can be: the markets at their
 * minimum separation, each fixture at the far edge of its own market's span.
 * Everything below is stated against this rather than against a second literal.
 */
const MIN_CROSS_MARKET_METERS = MIN_MARKET_SEPARATION_METERS - 2 * MAX_MARKET_SPAN_METERS

function coordOf(id: string) {
  const coord = FIXTURE_COORDS[id]
  if (coord === undefined) throw new Error(`unknown fixture id '${id}'`)
  return coord
}

const apart = (a: string, b: string): number => distanceMeters(coordOf(a), coordOf(b))

const declaredRelation = (a: string, b: string) =>
  MARKET_RELATIONS.find((entry) => entry.fixtures.includes(a) && entry.fixtures.includes(b))

/** `key: "value"` out of wrangler.jsonc, which is JSONC and so not JSON.parse-able. */
function wranglerVar(name: string): string {
  const found = wranglerSource.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))
  if (found === null) throw new Error(`wrangler.jsonc has no var ${name}`)
  return found[1]
}

describe('the fixture table', () => {
  it('has enough scenarios that the checks below are checking something', () => {
    expect(scenarioNames.length).toBeGreaterThan(10)
    expect(fixtureIds.length).toBeGreaterThan(20)
  })

  it('names a real market for every scenario, and a real fixture for every member', () => {
    for (const [scenario, spec] of Object.entries(SCENARIOS)) {
      expect(marketNames, `${scenario} names unknown market '${spec.market}'`).toContain(
        spec.market,
      )
      expect(['smoke', 'e2e'], `${scenario}.lane`).toContain(spec.lane)
      expect(spec.what.length, `${scenario}.what should say what it proves`).toBeGreaterThan(20)
      for (const id of spec.fixtures) {
        const coord = FIXTURE_COORDS[id]
        expect(coord, `${scenario} references unknown fixture '${id}'`).toBeDefined()
        expect(Number.isFinite(coord.lat), `${id}.lat`).toBe(true)
        expect(Number.isFinite(coord.lng), `${id}.lng`).toBe(true)
      }
    }
  })

  it('gives every fixture exactly one scenario, so no fixture has two owners', () => {
    const seen = new Map<string, string>()
    for (const [scenario, spec] of Object.entries(SCENARIOS)) {
      for (const id of spec.fixtures) {
        const owner = seen.get(id)
        expect(
          owner,
          `fixture '${id}' belongs to both '${owner}' and '${scenario}' — a fixture driven by ` +
            'two scenarios cannot be isolated from either',
        ).toBeUndefined()
        seen.set(id, scenario)
      }
    }
    // And nothing is defined but forgotten: an orphan coordinate is a fixture
    // whose isolation nothing below is checking.
    for (const id of fixtureIds) {
      expect(seen.has(id), `fixture '${id}' is in FIXTURE_COORDS but in no scenario`).toBe(true)
    }
  })

  it('places the server-resolved market on the demo origin the server actually uses', () => {
    // Nothing can choose where a promptless socket lands, so this market exists to
    // be *avoided*. If `DEMO_ORIGIN` moves and this does not, every separation
    // check below keeps passing while the thing it is protecting stops being true.
    expect(MARKETS.serverResolved.lat).toBe(DEMO_ORIGIN.lat)
    expect(MARKETS.serverResolved.lng).toBe(DEMO_ORIGIN.lng)
  })
})

describe('the separation margin is stated against the real match radius', () => {
  it('leaves an order of magnitude of headroom over the radius in force', () => {
    // The point of the margin: someone trying a 3- or 5-mile radius must not have
    // to re-derive this whole table, and must not silently lose the isolation.
    expect(MIN_CROSS_MARKET_METERS).toBeGreaterThan(DEFAULT_MATCH_RADIUS_METERS * 10)
  })

  it('keeps a market small enough to be one market', () => {
    expect(MAX_MARKET_SPAN_METERS * 2).toBeLessThan(MIN_MARKET_SEPARATION_METERS)
  })
})

describe('markets are separated by distance, not by cell', () => {
  for (let x = 0; x < marketNames.length; x += 1) {
    for (let y = x + 1; y < marketNames.length; y += 1) {
      const a = marketNames[x]
      const b = marketNames[y]
      it(`'${a}' and '${b}' are more than ${MIN_MARKET_SEPARATION_METERS / 1000} km apart`, () => {
        const meters = distanceMeters(MARKETS[a], MARKETS[b])
        expect(
          meters,
          `markets '${a}' and '${b}' are only ${Math.round(meters / 1000)} km apart`,
        ).toBeGreaterThan(MIN_MARKET_SEPARATION_METERS)
      })
    }
  }

  it('keeps every fixture inside its own market', () => {
    for (const [id, market] of marketOf) {
      const meters = distanceMeters(coordOf(id), MARKETS[market])
      expect(
        meters,
        `fixture '${id}' is ${Math.round(meters / 1000)} km from the centre of '${market}'`,
      ).toBeLessThanOrEqual(MAX_MARKET_SPAN_METERS)
    }
  })

  it('separates every pair of fixtures in different markets by far more than the radius', () => {
    let closest = Number.POSITIVE_INFINITY
    let closestPair = ''
    for (let x = 0; x < fixtureIds.length; x += 1) {
      for (let y = x + 1; y < fixtureIds.length; y += 1) {
        const a = fixtureIds[x]
        const b = fixtureIds[y]
        if (marketOf.get(a) === marketOf.get(b)) continue
        const meters = apart(a, b)
        if (meters < closest) {
          closest = meters
          closestPair = `${a} <-> ${b}`
        }
      }
    }
    expect(
      closest,
      `the closest two fixtures in different markets (${closestPair}) are ${Math.round(
        closest / 1000,
      )} km apart. Two scenarios inside each other's match radius will pair across their own ` +
        'boundaries, and it will show up as an intermittent failure rather than a broken test.',
    ).toBeGreaterThan(MIN_CROSS_MARKET_METERS)
  })

  it('keeps every explicitly-placed fixture clear of the demo origin', () => {
    // A socket that sends no coordinates lands here, and no fixture can stop it.
    for (const id of fixtureIds) {
      if (marketOf.get(id) === 'serverResolved') continue
      const meters = distanceMeters(coordOf(id), DEMO_ORIGIN)
      expect(
        meters,
        `fixture '${id}' is ${Math.round(meters / 1000)} km from DEMO_ORIGIN, where every ` +
          'promptless socket is placed',
      ).toBeGreaterThan(MIN_CROSS_MARKET_METERS)
    }
  })
})

describe('each market is still one Durable Object', () => {
  const configuredPrecision = Number(wranglerVar('POOL_CELL_PRECISION'))

  it('is sharded at the precision wrangler.jsonc actually deploys', () => {
    // Derived, not restated: a hardcoded precision in a test is the same defect as
    // a hardcoded timeout, and it is how a guard ends up asserting the geometry of
    // a configuration nobody runs.
    expect(configuredPrecision).toBe(DEFAULT_POOL_CELL_PRECISION)
  })

  for (const market of marketNames) {
    const members = fixtureIds.filter((id) => marketOf.get(id) === market)
    if (members.length < 2) continue
    it(`'${market}' fixtures share one shard`, () => {
      const cells = new Set(
        members.map((id) => geohash(coordOf(id).lat, coordOf(id).lng, configuredPrecision)),
      )
      expect(
        [...cells],
        `'${market}' spans ${cells.size} shards, so its scenario is split across that many ` +
          'Durable Objects and its buyers cannot see each other at all',
      ).toHaveLength(1)
    })
  }
})

describe('the in-market relationships each scenario depends on', () => {
  it('declares only real fixtures, with a stated reason', () => {
    for (const entry of MARKET_RELATIONS) {
      expect(entry.fixtures).toHaveLength(2)
      for (const id of entry.fixtures) expect(fixtureIds).toContain(id)
      const [a, b] = entry.fixtures
      expect(
        marketOf.get(a),
        `${a}/${b} declares a relationship across markets, where distance already decides`,
      ).toBe(marketOf.get(b))
      expect(entry.why.length).toBeGreaterThan(20)
    }
  })

  it('holds every declared relationship against the coordinates', () => {
    for (const entry of MARKET_RELATIONS) {
      const [a, b] = entry.fixtures
      const meters = apart(a, b)
      const label = `${a}/${b} (${Math.round(meters)} m)`
      switch (entry.relation) {
        case 'same-point':
          expect(meters, `${label} is declared same-point`).toBe(0)
          break
        case 'within-radius':
          expect(meters, `${label} is declared within the radius`).toBeLessThanOrEqual(
            DEFAULT_MATCH_RADIUS_METERS,
          )
          break
        case 'beyond-radius':
          expect(
            meters,
            `${label} is declared beyond the radius, but it is inside it — the scenario relying ` +
              'on these two not pairing will now fail, or pass for the wrong reason',
          ).toBeGreaterThan(DEFAULT_MATCH_RADIUS_METERS)
          break
      }
      if (entry.straddlesFineCell === true) {
        const fine = (id: string) => geohash(coordOf(id).lat, coordOf(id).lng, 6)
        expect(
          fine(a),
          `${label} is declared to straddle a geohash-6 boundary, which is what makes it a ` +
            'regression guard against fine-grained sharding coming back',
        ).not.toBe(fine(b))
      }
    }
  })

  it('requires anything not within the radius of its market-mate to say so', () => {
    for (let x = 0; x < fixtureIds.length; x += 1) {
      for (let y = x + 1; y < fixtureIds.length; y += 1) {
        const a = fixtureIds[x]
        const b = fixtureIds[y]
        if (marketOf.get(a) !== marketOf.get(b)) continue
        if (declaredRelation(a, b) !== undefined) continue
        const meters = apart(a, b)
        expect(
          meters,
          `'${a}' and '${b}' share a market but are ${Math.round(meters)} m apart, beyond the ` +
            'match radius. Two fixtures in one market are expected to be able to reach each ' +
            'other; if that is deliberate, declare it in MARKET_RELATIONS in ' +
            'scripts/pool-fixtures.mjs with a reason.',
        ).toBeLessThanOrEqual(DEFAULT_MATCH_RADIUS_METERS)
        // And a coordinate collision is never accidental: #80's defect was two
        // fixtures at the same point with nobody having said so.
        expect(
          meters,
          `'${a}' and '${b}' sit on the same coordinate with no declared reason — this is the ` +
            'collision issue #80 was filed about',
        ).toBeGreaterThan(0)
      }
    }
  })

  it('pins the two distances issue #82 is actually about', () => {
    // Stated in miles because the product rule is in miles, derived from the same
    // conversion the screen uses.
    const miles = (a: string, b: string) => apart(a, b) / METERS_PER_MILE
    expect(miles('mia', 'theo')).toBeCloseTo(1.5, 2)
    expect(apart('mia', 'theo')).toBeLessThanOrEqual(DEFAULT_MATCH_RADIUS_METERS)
    expect(miles('kim', 'lee')).toBeCloseTo(3, 2)
    expect(apart('kim', 'lee')).toBeGreaterThan(DEFAULT_MATCH_RADIUS_METERS)
  })
})

describe('the radius is configured in one place', () => {
  it('matches wrangler.jsonc to the default the code derives', () => {
    expect(Number(wranglerVar('MATCH_RADIUS_METERS'))).toBe(DEFAULT_MATCH_RADIUS_METERS)
  })

  it('appears as a literal nowhere else in the source', () => {
    const sources = {
      ...(import.meta.glob('../src/**/*.{ts,tsx}', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
      ...(import.meta.glob('../shared/**/*.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
      ...(import.meta.glob('../worker/**/*.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
      ...(import.meta.glob('../e2e/**/*.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
      ...(import.meta.glob('../scripts/**/*.{mjs,ts}', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
    }
    const literal = String(DEFAULT_MATCH_RADIUS_METERS)
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes(literal))
      .map(([path]) => path)
    expect(
      offenders,
      `${literal} is the match radius, and it belongs in wrangler.jsonc only: the client is ` +
        'told the figure by the server in `welcome`, and the code derives its fallback from ' +
        'METERS_PER_MILE. A copy here is a second place to forget.',
    ).toEqual([])
  })

  it('has exactly one fixture table', () => {
    // A second table is how #80 happened in the first place: two lists of
    // coordinates that nobody was comparing.
    const modules = import.meta.glob('../scripts/**/*.mjs', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const tables = Object.entries(modules)
      .filter(([, text]) => text.includes('export const FIXTURE_COORDS'))
      .map(([path]) => path)
    expect(tables, 'more than one module exports a fixture coordinate table').toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
// The job graph, read as text: which job runs which lane, and in which step, is
// the only thing isolating a scenario that has no coordinate to be far from.
import ciWorkflow from '../.github/workflows/ci.yml?raw'
// scripts/pool-fixtures.mjs is a plain, side-effect-free data module — unlike
// scripts/smoke.mjs itself, importing it does not dial a dev server.
import {
  FIXTURE_COORDS,
  LANES,
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
import { jobIds, jobSteps } from './lib/ci-workflow'

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
 *
 * Issue #96 is the hole in that: a scenario whose sockets send no coordinates has
 * no fixture, so it was absent from every check here — and an absence is reported
 * as a pass. Those scenarios are isolated in time instead, by the CI job graph and
 * by whatever serializes the lane inside one job, and the last block of this file
 * derives that from `.github/workflows/ci.yml` rather than from a list of
 * scenarios somebody remembered to keep current.
 */

const scenarioNames = Object.keys(SCENARIOS)
const fixtureIds = Object.keys(FIXTURE_COORDS)
const marketNames = Object.keys(MARKETS)
const laneNames = Object.keys(LANES)

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
      // Derived from LANES rather than restated as an enum here: the lane is what
      // isolates a fixture-less scenario, and a lane with no entry there has no
      // runner, no CI job and therefore no isolation story at all (#96).
      expect(laneNames, `${scenario}.lane names a lane LANES does not declare`).toContain(spec.lane)
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

/**
 * The scenarios distance cannot isolate, and the reason a vacuous pass is not a
 * pass (issue #96).
 *
 * Every check above iterates fixtures. A scenario whose sockets send no
 * coordinates has none — the server places them, on `DEMO_ORIGIN`, and nothing
 * can choose otherwise — so it appeared in none of those checks, and a check that
 * examined nothing is indistinguishable in the output from one that examined
 * something and found it correct. This repo has been bitten by exactly that
 * ambiguity before: a storage scan during #73's review reported a clean bill of
 * health on text that was provably on disk, and only its author mutation-testing
 * his own scan caught it.
 *
 * So these scenarios get the check that matches how they are *actually* kept
 * apart: in time, not in space. Two mechanisms, both derived here rather than
 * declared:
 *
 *  1. **The job graph.** Two different CI jobs are two machines with a `pnpm dev`
 *     each, and two steps of one job run in sequence. So two scenarios driven by
 *     different runner commands can never be live against one dev server — read
 *     out of `.github/workflows/ci.yml`, including that neither command is
 *     backgrounded, since a `&` would let one step outlive itself into the next.
 *  2. **The lane's own serializer**, for the only case the job graph cannot
 *     answer: several fixture-less scenarios driven by *one* runner. Today that is
 *     the `e2e` lane and `playwright.config.ts`'s `workers: 1`, and the claim is
 *     checked against that file's source — raise it to 2 and this block goes red
 *     rather than the isolation going quietly away.
 */
describe('the scenarios the server places itself are isolated in time, not by distance', () => {
  const ciJobs = jobIds(ciWorkflow)
  /** Scenarios with no coordinate of their own — every distance check above skips these. */
  const serverPlaced = scenarioNames.filter((name) => SCENARIOS[name].fixtures.length === 0)
  const explicitlyPlaced = scenarioNames.filter((name) => SCENARIOS[name].fixtures.length > 0)

  /** Steps of `job` that invoke `command`, by position, so sequence is readable. */
  const stepsInvoking = (job: string, command: string): number[] =>
    jobSteps(ciWorkflow, job).flatMap((step, index) => (step.includes(command) ? [index] : []))

  const jobsInvoking = (command: string): string[] =>
    ciJobs.filter((job) => stepsInvoking(job, command).length > 0)

  /** Source of a file at the repo root, which is where a lane's serializer lives. */
  const rootSources = import.meta.glob('../*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const rootSource = (file: string): string => {
    const text = rootSources[`../${file}`]
    if (text === undefined) {
      throw new Error(
        `cannot read '${file}', so the serializer claiming to live there cannot be checked. ` +
          'A lane serializer must be a .ts file at the repo root; if that has to change, widen ' +
          'the glob here rather than leaving the claim unverified.',
      )
    }
    return text
  }

  it('has scenarios to check, so this block is not the vacuous pass it replaces', () => {
    // If this ever reaches zero, delete this block — leaving it green would be the
    // same defect one level up.
    expect(
      serverPlaced,
      'no scenario has an empty `fixtures` list any more, so nothing here is being checked',
    ).not.toEqual([])
    expect([...serverPlaced, ...explicitlyPlaced].sort()).toEqual([...scenarioNames].sort())
  })

  it('reaches every scenario between them: by distance, or by lane, never neither', () => {
    // The partition is the anti-vacuity property. A scenario is either measured
    // above (it has fixtures, and `marketOf` carries every one of them) or named
    // below (it has none, and its lane is its isolation).
    for (const name of explicitlyPlaced) {
      for (const id of SCENARIOS[name].fixtures) {
        expect(marketOf.get(id), `fixture '${id}' of '${name}' is in no market`).toBe(
          SCENARIOS[name].market,
        )
      }
    }
    expect(explicitlyPlaced.length + serverPlaced.length).toBe(scenarioNames.length)
  })

  it('keeps the server-resolved market and the fixture-less scenarios the same set', () => {
    // Both directions matter. A fixture-less scenario in some other market would be
    // claiming an isolation nobody checks, and an explicitly-placed fixture inside
    // `serverResolved` would sit where every promptless socket lands — which the
    // "clear of the demo origin" check above exempts by market, so it would pass.
    for (const name of serverPlaced) {
      expect(
        SCENARIOS[name].market,
        `'${name}' has no fixtures, so only the server can have placed it — that is the ` +
          '`serverResolved` market, and declaring any other one claims a distance nothing measures',
      ).toBe('serverResolved')
    }
    for (const name of explicitlyPlaced) {
      expect(
        SCENARIOS[name].market,
        `'${name}' places its own fixtures inside the market reserved for sockets the server ` +
          'places, where they would share a Durable Object with every promptless socket in the suite',
      ).not.toBe('serverResolved')
    }
  })

  it('declares exactly the lanes the scenario table uses, and no more', () => {
    const used = [...new Set(scenarioNames.map((name) => SCENARIOS[name].lane))].sort()
    expect(
      [...laneNames].sort(),
      'LANES and the scenario table disagree about which lanes exist. A lane in one and not the ' +
        'other is either a scenario nothing runs or an isolation story for nothing.',
    ).toEqual(used)
  })

  for (const [lane, spec] of Object.entries(LANES)) {
    for (const runner of spec.runners) {
      it(`'${lane}' is run by CI as '${runner}', in the foreground`, () => {
        const jobs = jobsInvoking(runner)
        expect(
          jobs,
          `no step in .github/workflows/ci.yml runs '${runner}'. The whole isolation argument ` +
            'for a fixture-less scenario is which job and which step runs it, so a runner CI ' +
            'does not invoke — renamed, dropped, or never wired — leaves that scenario isolated ' +
            'by nothing.',
        ).not.toEqual([])
        for (const job of jobs) {
          for (const step of jobSteps(ciWorkflow, job).filter((text) => text.includes(runner))) {
            const backgrounded = step
              .split('\n')
              .some((line) => line.includes(runner) && /&\s*$/.test(line))
            expect(
              backgrounded,
              `job '${job}' backgrounds '${runner}'. Steps run in sequence, which is what keeps ` +
                'two lanes in one job out of each other’s market; a backgrounded one outlives ' +
                'its own step and can be live during the next.',
            ).toBe(false)
          }
        }
      })
    }
  }

  for (let x = 0; x < serverPlaced.length; x += 1) {
    for (let y = x + 1; y < serverPlaced.length; y += 1) {
      const a = serverPlaced[x]
      const b = serverPlaced[y]
      it(`'${a}' and '${b}' cannot be live against one dev server at the same time`, () => {
        const laneA = SCENARIOS[a].lane
        const laneB = SCENARIOS[b].lane

        if (laneA === laneB) {
          // One runner, one job, one dev server: the job graph has nothing to say,
          // so the lane's own serializer is the entire argument.
          const serializer = LANES[laneA].serializer
          expect(
            serializer,
            `'${a}' and '${b}' are both driven by the '${laneA}' lane, so CI cannot separate ` +
              'them — they share a job, a dev server and the Durable Object on the demo origin. ' +
              `Declare what serializes them in LANES.${laneA}.serializer in ` +
              'scripts/pool-fixtures.mjs, or give one of them a runner of its own.',
          ).not.toBeNull()
          if (serializer === null) return
          expect(serializer.why.length, `LANES.${laneA}.serializer.why`).toBeGreaterThan(20)
          expect(
            rootSource(serializer.file),
            `LANES.${laneA}.serializer claims '${serializer.file}' contains ` +
              `'${serializer.claim}', and it does not. That claim is the only thing standing ` +
              `between '${a}' and '${b}' queueing buyers in the same Durable Object at once.`,
          ).toContain(serializer.claim)
          return
        }

        // Different lanes: different commands, and a command is a step. Two steps
        // of one job run in sequence and two jobs are two machines, so the only
        // way these could overlap is one step invoking both.
        const runnersA = LANES[laneA].runners
        const runnersB = LANES[laneB].runners
        expect(
          runnersA.filter((runner) => runnersB.includes(runner)),
          `lanes '${laneA}' and '${laneB}' share a runner command, so "different lanes" is not ` +
            'the separation it looks like',
        ).toEqual([])
        for (const job of ciJobs) {
          const stepsA = new Set(runnersA.flatMap((runner) => stepsInvoking(job, runner)))
          const stepsB = new Set(runnersB.flatMap((runner) => stepsInvoking(job, runner)))
          if (stepsA.size === 0 || stepsB.size === 0) continue
          const shared = [...stepsA].filter((step) => stepsB.has(step))
          expect(
            shared,
            `one step of job '${job}' runs both the '${laneA}' and '${laneB}' lanes, so ` +
              `'${a}' and '${b}' can be live against that job's one dev server together`,
          ).toEqual([])
        }
      })
    }
  }
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

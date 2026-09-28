import { describe, expect, it } from 'vitest'
// scripts/smoke-fixtures.mjs is a plain, side-effect-free data module — unlike
// scripts/smoke.mjs itself, importing it does not dial a dev server.
import { FIXTURE_COORDS, SCENARIOS, SHARED_CELL_EXCEPTIONS } from '../scripts/smoke-fixtures.mjs'
import { geohash } from '../shared/geo'

/**
 * scripts/smoke.mjs is a live end-to-end driver, and every scenario in it
 * claims — in its own comments — to be isolated in a cell of its own. That
 * claim is invisible to every check this repo otherwise runs: not a merge
 * conflict, not a type error, not a lint finding, and `vitest` never reaches
 * the Durable Object that would actually notice two scenarios sharing a cell.
 * `pnpm smoke` does not reliably catch it either, because two scenarios in one
 * cell is a *race* between them, not a deterministic failure.
 *
 * Issue #80 is the incident that motivated this file: on PR #73, a Judge
 * merging `origin/main` found two unrelated scenarios' fixtures sitting at
 * byte-identical coordinates — same cell, same `NuggPool` Durable Object,
 * silently defeating the per-cell isolation each scenario's comments assume —
 * and fixed it in a merge commit. A later rebase of the same branch replayed
 * the same conflict and resolved it the *other* way, putting the collision
 * back with nothing in CI able to tell. The only reason it never reached
 * `main` was two agents in a row happening to eyeball the coordinate
 * literals.
 *
 * This test is the mechanical replacement for that eyeballing: it derives
 * every scenario's cell from the repo's own `geohash()` (shared/geo.ts) and
 * the fixture coordinate table in scripts/smoke-fixtures.mjs — the same table
 * scripts/smoke.mjs imports its coordinates from, so there is exactly one
 * source of truth rather than a hand-maintained list of "expected" cells that
 * could quietly drift out of sync with the actual fixtures.
 */

const CELL_PRECISION = 6

const scenarioNames = Object.keys(SCENARIOS)

function cellsFor(scenario: string): Set<string> {
  const members = SCENARIOS[scenario]
  const cells = new Set<string>()
  for (const id of members) {
    const coord = FIXTURE_COORDS[id]
    if (!coord) {
      throw new Error(`SCENARIOS['${scenario}'] references unknown fixture id '${id}'`)
    }
    cells.add(geohash(coord.lat, coord.lng, CELL_PRECISION))
  }
  return cells
}

function declaredException(a: string, b: string) {
  return SHARED_CELL_EXCEPTIONS.find(
    (exception) => exception.scenarios.includes(a) && exception.scenarios.includes(b),
  )
}

describe('scripts/smoke.mjs scenario cell isolation', () => {
  it('has more than a handful of scenarios (a check with nothing to check proves nothing)', () => {
    expect(scenarioNames.length).toBeGreaterThan(5)
  })

  it('every fixture referenced by a scenario has a finite lat/lng', () => {
    for (const [scenario, members] of Object.entries(SCENARIOS)) {
      for (const id of members) {
        const coord = FIXTURE_COORDS[id]
        expect(coord, `${scenario} references unknown fixture '${id}'`).toBeDefined()
        expect(Number.isFinite(coord.lat), `${id}.lat`).toBe(true)
        expect(Number.isFinite(coord.lng), `${id}.lng`).toBe(true)
      }
    }
  })

  it('every declared exception names exactly two real scenarios', () => {
    for (const exception of SHARED_CELL_EXCEPTIONS) {
      expect(exception.scenarios).toHaveLength(2)
      for (const name of exception.scenarios) {
        expect(
          scenarioNames,
          `exception '${exception.name}' references unknown scenario '${name}'`,
        ).toContain(name)
      }
      expect(exception.reason.length).toBeGreaterThan(20)
    }
  })

  it('no declared exception is stale — it must still actually collide', () => {
    for (const exception of SHARED_CELL_EXCEPTIONS) {
      const [a, b] = exception.scenarios
      const shared = [...cellsFor(a)].filter((cell) => cellsFor(b).has(cell))
      expect(
        shared.length,
        `exception '${exception.name}' no longer collides — '${a}' and '${b}' now occupy ` +
          'distinct cells, so this exception should be removed rather than left declaring a ' +
          'collision that no longer exists',
      ).toBeGreaterThan(0)
    }
  })

  // Every unordered pair of scenarios must occupy disjoint sets of cells,
  // unless that exact pair is named in SHARED_CELL_EXCEPTIONS.
  for (let x = 0; x < scenarioNames.length; x += 1) {
    for (let y = x + 1; y < scenarioNames.length; y += 1) {
      const nameA = scenarioNames[x]
      const nameB = scenarioNames[y]
      const exception = declaredException(nameA, nameB)
      const label = exception
        ? `'${nameA}' vs '${nameB}' shares a cell only via the declared exception '${exception.name}'`
        : `'${nameA}' and '${nameB}' occupy distinct cells`

      it(label, () => {
        const shared = [...cellsFor(nameA)].filter((cell) => cellsFor(nameB).has(cell))
        if (exception) {
          expect(shared.length).toBeGreaterThan(0)
        } else {
          expect(
            shared,
            `undeclared cell collision between scenarios '${nameA}' and '${nameB}': ${shared.join(', ')}. ` +
              'If this is deliberate, add a named entry to SHARED_CELL_EXCEPTIONS in ' +
              'scripts/smoke-fixtures.mjs explaining why — see issue #80.',
          ).toEqual([])
        }
      })
    }
  }
})

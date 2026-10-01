/**
 * Type declarations for pool-fixtures.mjs, so test/fixture-separation.test.ts and
 * the specs in e2e/ get real types without turning on `allowJs`/`checkJs` for
 * every script in scripts/ (most of which are unchecked, ad-hoc Node CLIs by
 * design).
 */

export interface LatLng {
  lat: number
  lng: number
}

export interface Market extends LatLng {
  label: string
}

/**
 * A lane name is whatever `LANES` declares, and deliberately not a union written
 * out again here (#96).
 *
 * A second list of the lanes was exactly the defect: `test/fixture-separation.test.ts`
 * validated `lane` against a three-value enum of its own, which said nothing about
 * whether a lane had a runner, a CI job, or any isolation at all. The set is now
 * derived from `LANES` and checked against the scenario table and the CI job graph
 * in one place; a union here would be the copy that goes stale.
 */
export type FixtureLane = string

export interface Scenario {
  lane: FixtureLane
  market: string
  fixtures: string[]
  what: string
}

/**
 * What serializes a lane's own scenarios when the CI job graph cannot, named by
 * the file that implements it so the claim can be checked against the source.
 */
export interface LaneSerializer {
  file: string
  claim: string
  why: string
}

export interface Lane {
  /** The commands `.github/workflows/ci.yml` invokes, spelled as it spells them. */
  runners: string[]
  serializer: LaneSerializer | null
}

export type MarketRelation = 'within-radius' | 'beyond-radius' | 'same-point'

export interface MarketRelationDeclaration {
  fixtures: [string, string]
  relation: MarketRelation
  straddlesFineCell?: boolean
  why: string
}

export const MIN_MARKET_SEPARATION_METERS: number

export const MAX_MARKET_SPAN_METERS: number

export const MARKETS: Record<string, Market>

export const FIXTURE_COORDS: Record<string, LatLng>

export const LANES: Record<FixtureLane, Lane>

export const SCENARIOS: Record<string, Scenario>

export const MARKET_RELATIONS: MarketRelationDeclaration[]

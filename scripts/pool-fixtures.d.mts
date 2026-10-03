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

export type FixtureLane = 'smoke' | 'e2e' | 'payments'

export interface Scenario {
  lane: FixtureLane
  market: string
  fixtures: string[]
  what: string
  /**
   * The `package.json` script that drives this scenario — required on
   * `serverResolved`, where it is the whole isolation story, and meaningless
   * anywhere else (#96). Declared here so the separation test reads it rather
   * than casting `spec` to a shape this file does not admit: a cast would keep
   * compiling after the field was renamed, which is the one change that would
   * make the check stop finding anything.
   */
  runner?: string
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

export const SCENARIOS: Record<string, Scenario>

export const MARKET_RELATIONS: MarketRelationDeclaration[]

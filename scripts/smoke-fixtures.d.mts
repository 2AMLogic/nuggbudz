/**
 * Type declarations for smoke-fixtures.mjs, so test/smoke-fixture-cells.test.ts
 * gets real types without turning on `allowJs`/`checkJs` for every script in
 * scripts/ (most of which are unchecked, ad-hoc Node CLIs by design).
 */

export interface LatLng {
  lat: number
  lng: number
}

export const FIXTURE_COORDS: Record<string, LatLng>

export const SCENARIOS: Record<string, string[]>

export interface SharedCellException {
  name: string
  scenarios: [string, string]
  reason: string
}

export const SHARED_CELL_EXCEPTIONS: SharedCellException[]

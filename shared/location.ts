import type { LatLng } from './geo'

/**
 * Where a buyer's coordinates came from.
 *
 * NuggBudz never asks for location permission to pair. A prompt on a borrowed
 * phone, on venue wifi, with one wrong tap available, is a dead end — so the
 * cell is resolved from the most precise source already in hand, and the screen
 * says which one that was rather than implying a fix we do not have:
 *
 * - `client` — the buyer explicitly asked for their exact location, and the
 *   browser gave it up. The only rung that ever involves a prompt.
 * - `edge` — Cloudflare's approximate location for the inbound request
 *   (`request.cf.latitude`/`longitude`). Free, promptless, and city-level, which
 *   is exactly the resolution a precision-6 cell needs.
 * - `demo` — the fixed origin below, for when there is no usable `cf` to read:
 *   `cf` is absent outside a Workers runtime, and a miniflare that could not
 *   fetch one (offline, or a trimmed CI box) hands over an object with no
 *   coordinates in it. This rung is what keeps local `pnpm dev` and `pnpm smoke`
 *   pairing rather than erroring.
 */
export type LocationSource = 'client' | 'edge' | 'demo'

/** A resolved coordinate, plus the rung of the fallback that produced it. */
export interface LocationFix extends LatLng {
  source: LocationSource
}

/**
 * An unvalidated coordinate pair.
 *
 * Both of the sources that feed this are strings at best: query parameters, and
 * `request.cf`, whose `latitude`/`longitude` arrive as strings and may be
 * missing altogether. Nothing here is trusted, so the fields are `unknown` and
 * the only way through is `parseCoords`.
 */
export interface RawCoords {
  lat?: unknown
  lng?: unknown
}

/**
 * The location used when nothing better is available.
 *
 * A hackathon venue is exactly where every other rung can fail: no usable `cf`
 * on a local dev server, denied permissions on a borrowed phone, no GPS indoors.
 * Falling back to a fixed coordinate keeps pairing alive, and the UI says plainly
 * that it is doing so.
 */
export const DEMO_ORIGIN: LatLng = { lat: 37.7955, lng: -122.3937 }

const MAX_LAT = 90
const MAX_LNG = 180

/** One coordinate component, from a number or a string, within ±`limit`. */
function parseDegrees(raw: unknown, limit: number): number | null {
  if (typeof raw === 'number') return inRange(raw, limit)
  if (typeof raw !== 'string') return null
  // `Number('')` is 0, so an empty or blank string has to be refused before the
  // conversion rather than after it.
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return inRange(Number(trimmed), limit)
}

function inRange(value: number, limit: number): number | null {
  if (!Number.isFinite(value) || value < -limit || value > limit) return null
  return value
}

/**
 * Narrow an untrusted pair to a coordinate, or null.
 *
 * Partial input is no input: a latitude without a longitude resolves nothing, so
 * it falls through to the next rung instead of half-placing a buyer. Range is
 * checked here so `geohash()` can never be reached with an argument that would
 * make it throw a `RangeError` — thrown from inside a socket upgrade that would
 * surface to the buyer as a broken connection rather than a reason.
 */
export function parseCoords(raw: RawCoords | null | undefined): LatLng | null {
  if (raw === null || raw === undefined) return null
  const lat = parseDegrees(raw.lat, MAX_LAT)
  const lng = parseDegrees(raw.lng, MAX_LNG)
  if (lat === null || lng === null) return null
  return { lat, lng }
}

/**
 * Whether a caller put anything in this pair at all.
 *
 * The difference between "sent nothing" and "sent something unusable" matters at
 * the edge: the first is the normal promptless path, and the second is a client
 * bug that deserves a clear refusal rather than a silent move to another cell.
 */
export function coordsSupplied(raw: RawCoords | null | undefined): boolean {
  if (raw === null || raw === undefined) return false
  return present(raw.lat) || present(raw.lng)
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

/**
 * Choose a location from the rungs available, most precise first.
 *
 * Pure on purpose: this is the whole decision, and it is worth testing without a
 * Workers runtime to reach for. The origin is a parameter rather than a constant
 * read so a test can prove the last rung is genuinely a fallback.
 */
export function resolveLocation(
  client: RawCoords | null | undefined,
  edge: RawCoords | null | undefined,
  origin: LatLng = DEMO_ORIGIN,
): LocationFix {
  const supplied = parseCoords(client)
  if (supplied !== null) return { ...supplied, source: 'client' }

  const atEdge = parseCoords(edge)
  if (atEdge !== null) return { ...atEdge, source: 'edge' }

  return { ...origin, source: 'demo' }
}

/** Narrow a source that travelled as a string, e.g. through a query parameter. */
export function parseLocationSource(raw: unknown): LocationSource | null {
  switch (raw) {
    case 'client':
    case 'edge':
    case 'demo':
      return raw
    default:
      return null
  }
}

/** How a rung is named on screen, and what it honestly promises. */
export interface LocationSourceCopy {
  /** A short badge, shown next to the cell. */
  label: string
  /** A sentence for the buyer, saying how good this location actually is. */
  detail: string
}

/**
 * Wording for each rung.
 *
 * Only `client` may describe a location as exact; the other two say what they
 * are. Stated once, here, so the screen cannot drift into claiming a precision
 * the fix does not have.
 */
export function describeLocationSource(source: LocationSource): LocationSourceCopy {
  switch (source) {
    case 'client':
      return {
        label: 'your exact location',
        detail: 'Paired from your exact location, which you turned on.',
      }
    case 'edge':
      return {
        label: 'approximate, from the network',
        detail:
          'Paired from your approximate location — worked out from your connection, with no ' +
          'location prompt. Good to about a neighbourhood.',
      }
    case 'demo':
      return {
        label: 'demo cell',
        detail:
          'Paired on the fixed demo cell: no location was available for this connection. ' +
          'Everyone here lands in the same market.',
      }
  }
}

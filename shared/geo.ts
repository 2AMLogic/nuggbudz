const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const EARTH_RADIUS_METERS = 6371008.8

export interface LatLng {
  lat: number
  lng: number
}

/**
 * Metres in a statute mile, exactly.
 *
 * Distances are metres everywhere in code, the same way money is cents: miles
 * exist only where a person reads one. This is the single conversion, so no
 * caller has to pick its own rounding.
 */
export const METERS_PER_MILE = 1609.344

const FEET_PER_METER = 3.280839895

/**
 * How far apart two buyers may be and still be paired, by default.
 *
 * Two miles: for one box of nuggets a person will walk further than the 800 m
 * this used to be, and the walk — not a grid line — is the only thing that
 * should decide whether a split is practical. Derived from `METERS_PER_MILE`
 * rather than written out so the metre value lives in exactly one place: the
 * deployed number is `MATCH_RADIUS_METERS` in `wrangler.jsonc`, and this is
 * what a runtime with no var set falls back to.
 */
export const DEFAULT_MATCH_RADIUS_METERS = Math.round(2 * METERS_PER_MILE)

/**
 * Geohash precision for the shard key, by default.
 *
 * Coarse on purpose, and the number matters. The cell is no longer the market —
 * `DEFAULT_MATCH_RADIUS_METERS` is — so the cell's only remaining job is to
 * contain every candidate a buyer at its centre could pair with. At precision 6
 * the cell (~1.2 km) is *smaller* than the 6.4 km diameter of that radius, so
 * the grid would still be the real constraint; precision 5 (~4.9 km) is smaller
 * too; precision 4 (~39 x 19.5 km) contains it, but over half of that box lies
 * within 3.2 km of an edge, so a majority of buyers would have part of their
 * circle clipped. Precision 3 (~156 km) reduces that to a small minority.
 *
 * That trades contention for correctness, and it is the safe direction to trade:
 * coarsening keeps one Durable Object authoritative over every candidate it
 * might pair, which is what makes double-pairing impossible without locking.
 * The alternative — fine cells plus a fan-out to the eight neighbours — needs
 * cross-object coordination and gives that invariant up.
 */
export const DEFAULT_POOL_CELL_PRECISION = 3

/**
 * Encode a coordinate as a geohash of the given precision.
 *
 * NuggBudz uses the geohash purely as a shard key: every buyer whose location
 * encodes to the same cell lands in the same Durable Object, and matching inside
 * it is decided by distance. See `DEFAULT_POOL_CELL_PRECISION` for why the shard
 * is deliberately much larger than the market it has to contain.
 */
export function geohash(lat: number, lng: number, precision = DEFAULT_POOL_CELL_PRECISION): string {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError(`bad latitude: ${lat}`)
  if (!Number.isFinite(lng) || lng < -180 || lng > 180)
    throw new RangeError(`bad longitude: ${lng}`)
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new RangeError(`precision must be an integer in 1..12, got ${precision}`)
  }

  let latMin = -90
  let latMax = 90
  let lngMin = -180
  let lngMax = 180
  let hash = ''
  let bits = 0
  let bitCount = 0
  let evenBit = true

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2
      if (lng >= mid) {
        bits = (bits << 1) | 1
        lngMin = mid
      } else {
        bits = bits << 1
        lngMax = mid
      }
    } else {
      const mid = (latMin + latMax) / 2
      if (lat >= mid) {
        bits = (bits << 1) | 1
        latMin = mid
      } else {
        bits = bits << 1
        latMax = mid
      }
    }
    evenBit = !evenBit
    bitCount += 1
    if (bitCount === 5) {
      hash += BASE32[bits]
      bits = 0
      bitCount = 0
    }
  }

  return hash
}

/** A cell's boundary, in plain degrees, corner to corner. */
export interface BoundingBox {
  latMin: number
  latMax: number
  lngMin: number
  lngMax: number
}

/**
 * Decode a geohash back to the bounding box it represents.
 *
 * The exact inverse of `geohash`'s bit-interleaving loop: same even/odd bit
 * order, same binary-search halving, just reading bits out of each base32
 * character instead of deciding them. Nothing on screen draws this any more —
 * the shard is not a shape a buyer has a model for, and the map draws the match
 * radius instead — but the inverse is what lets a test assert which shard a
 * coordinate landed in without reimplementing the encoder.
 */
export function decodeCell(hash: string): BoundingBox {
  if (hash.length === 0) throw new RangeError('geohash must not be empty')

  let latMin = -90
  let latMax = 90
  let lngMin = -180
  let lngMax = 180
  let evenBit = true

  for (const char of hash) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new RangeError(`bad geohash character: ${char}`)

    for (let bit = 4; bit >= 0; bit -= 1) {
      const value = (index >> bit) & 1
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2
        if (value === 1) lngMin = mid
        else lngMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if (value === 1) latMin = mid
        else latMax = mid
      }
      evenBit = !evenBit
    }
  }

  return { latMin, latMax, lngMin, lngMax }
}

const METERS_PER_DEGREE_LAT = 111_320

/**
 * Snap a coordinate to a coarse grid, in place of the buyer's real position.
 *
 * This is the only place a waiting buyer's location leaves the server: the
 * Durable Object calls this before broadcasting a roster to anyone who is not
 * yet matched to that buyer, so an unmatched buyer never sees where anyone
 * else is actually standing — only which rough patch of ground they are on.
 */
export function snapToGrid(point: LatLng, meters = 75): LatLng {
  if (!Number.isFinite(meters) || meters <= 0) {
    throw new RangeError(`grid size must be a positive number of metres, got ${meters}`)
  }

  const snap = (value: number, step: number) => Math.round(value / step) * step

  const latStep = meters / METERS_PER_DEGREE_LAT
  const snappedLat = snap(point.lat, latStep)

  // Longitude degrees shrink toward the poles; clamp cos(lat) away from zero
  // so a buyer at extreme latitude cannot divide the step down to nothing.
  // Deriving this from the *snapped* latitude, not the raw input, is what
  // keeps re-snapping an already-snapped point a no-op: the longitude step
  // only ever depends on a value that has already landed on the grid.
  const cosLat = Math.max(Math.cos((snappedLat * Math.PI) / 180), 1e-6)
  const lngStep = meters / (METERS_PER_DEGREE_LAT * cosLat)

  return { lat: snappedLat, lng: snap(point.lng, lngStep) }
}

/** Great-circle distance in metres between two coordinates. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Where a distance stops being read in feet and starts being read in miles.
 *
 * A tenth of a mile. Below it "0.1 mi" is the only thing miles can say and a
 * person crossing a car park wants a number that changes; above it, feet stop
 * meaning anything to somebody deciding whether to walk.
 */
const FEET_CUTOVER_METERS = METERS_PER_MILE / 10

/**
 * A distance rendered for a buddy card, e.g. '250 ft away' or '1.3 mi away'.
 *
 * The one place a distance is formatted, so the units are decided once. Feet and
 * miles because the radius is quoted in miles on screen and a buddy card that
 * answered in kilometres would be a second system to translate between. Metres
 * stay canonical everywhere else — this function is the boundary.
 */
export function formatDistance(meters: number): string {
  if (meters < FEET_CUTOVER_METERS) {
    // To the nearest ten feet, and never zero: "0 ft away" reads as an error
    // rather than as two people standing together.
    const feet = Math.max(10, Math.round((meters * FEET_PER_METER) / 10) * 10)
    return `${feet} ft away`
  }
  return `${(meters / METERS_PER_MILE).toFixed(1)} mi away`
}

/**
 * A radius named the way it is offered to a buyer, e.g. '2 mi'.
 *
 * Trailing zeroes trimmed, because '2 mi' is the promise and '2.0 mi' reads like
 * a measurement. Derived from whatever the server sent, so re-pricing the radius
 * changes the copy with it and no screen carries its own idea of how far.
 */
export function formatMiles(meters: number): string {
  const miles = meters / METERS_PER_MILE
  const rounded = miles >= 1 ? Math.round(miles * 10) / 10 : Math.round(miles * 100) / 100
  return `${rounded} mi`
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const EARTH_RADIUS_METERS = 6371008.8

export interface LatLng {
  lat: number
  lng: number
}

/**
 * Encode a coordinate as a geohash of the given precision.
 *
 * NuggBudz uses the geohash purely as a shard key: every buyer whose location
 * encodes to the same cell lands in the same Durable Object and therefore the
 * same matching market. Precision 6 is roughly a 1.2km x 0.6km box.
 */
export function geohash(lat: number, lng: number, precision = 6): string {
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
 * character instead of deciding them. A client that only has the cell string
 * (never a buyer's raw coordinate) uses this to draw the cell it is standing
 * in, which is the whole point of shipping a hash instead of a point.
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
 * else is actually standing — only which rough patch of the cell they are in.
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

/** A distance rendered for a buddy card, e.g. '120 m away' or '1.3 km away'. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m away`
  return `${(meters / 1000).toFixed(1)} km away`
}

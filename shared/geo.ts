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

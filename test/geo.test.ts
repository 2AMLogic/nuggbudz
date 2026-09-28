import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MATCH_RADIUS_METERS,
  DEFAULT_POOL_CELL_PRECISION,
  decodeCell,
  distanceMeters,
  formatDistance,
  formatMiles,
  geohash,
  METERS_PER_MILE,
  snapToGrid,
} from '../shared/geo'

describe('geohash', () => {
  it('matches the canonical reference vector', () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
  })

  it('is a prefix code, so a coarser cell contains the finer one', () => {
    const fine = geohash(37.7749, -122.4194, 9)
    for (let p = 1; p < 9; p += 1) {
      expect(geohash(37.7749, -122.4194, p)).toBe(fine.slice(0, p))
    }
  })

  it('puts nearby points in the same precision-6 cell', () => {
    expect(geohash(37.7749, -122.4194, 6)).toBe(geohash(37.7752, -122.4191, 6))
  })

  it('puts distant points in different cells', () => {
    expect(geohash(37.7749, -122.4194, 6)).not.toBe(geohash(40.7128, -74.006, 6))
  })

  it('rejects out-of-range input rather than returning a wrong cell', () => {
    expect(() => geohash(91, 0)).toThrow(RangeError)
    expect(() => geohash(0, 181)).toThrow(RangeError)
    expect(() => geohash(0, 0, 0)).toThrow(RangeError)
    expect(() => geohash(0, 0, 13)).toThrow(RangeError)
  })
})

describe('decodeCell', () => {
  it('matches the canonical reference vector', () => {
    const box = decodeCell('u4pruydqqvj')
    expect(box.latMin).toBeLessThanOrEqual(57.64911)
    expect(box.latMax).toBeGreaterThanOrEqual(57.64911)
    expect(box.lngMin).toBeLessThanOrEqual(10.40744)
    expect(box.lngMax).toBeGreaterThanOrEqual(10.40744)
  })

  it('is the exact inverse of the encoder: the box always contains the original point', () => {
    const points = [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 0, lng: 0 },
      { lat: -33.8688, lng: 151.2093 },
      { lat: 89.9, lng: 179.9 },
      { lat: -89.9, lng: -179.9 },
    ]
    for (const point of points) {
      for (let precision = 1; precision <= 12; precision += 1) {
        const hash = geohash(point.lat, point.lng, precision)
        const box = decodeCell(hash)
        expect(box.latMin).toBeLessThanOrEqual(point.lat)
        expect(box.latMax).toBeGreaterThanOrEqual(point.lat)
        expect(box.lngMin).toBeLessThanOrEqual(point.lng)
        expect(box.lngMax).toBeGreaterThanOrEqual(point.lng)
      }
    }
  })

  it('shrinks monotonically as precision increases', () => {
    const fine = decodeCell(geohash(37.7749, -122.4194, 9))
    const coarse = decodeCell(geohash(37.7749, -122.4194, 3))
    expect(fine.latMax - fine.latMin).toBeLessThan(coarse.latMax - coarse.latMin)
    expect(fine.lngMax - fine.lngMin).toBeLessThan(coarse.lngMax - coarse.lngMin)
  })

  it('rejects an empty hash or an invalid character', () => {
    expect(() => decodeCell('')).toThrow(RangeError)
    expect(() => decodeCell('u4a!')).toThrow(RangeError)
  })
})

describe('snapToGrid', () => {
  it('never returns the exact input coordinate a buyer supplied', () => {
    const point = { lat: 37.774912345, lng: -122.419412345 }
    const snapped = snapToGrid(point)
    expect(snapped).not.toEqual(point)
  })

  it('puts two nearby buyers on the same coarse dot', () => {
    const a = snapToGrid({ lat: 37.7749, lng: -122.4194 })
    const b = snapToGrid({ lat: 37.77491, lng: -122.41941 })
    expect(a).toEqual(b)
  })

  it('is stable — snapping an already-snapped point is a no-op', () => {
    const once = snapToGrid({ lat: 37.7749, lng: -122.4194 })
    expect(snapToGrid(once)).toEqual(once)
  })

  it('stays within half a grid cell of the true position', () => {
    const point = { lat: 37.7749, lng: -122.4194 }
    const snapped = snapToGrid(point, 75)
    expect(distanceMeters(point, snapped)).toBeLessThan(75)
  })

  it('rejects a non-positive grid size', () => {
    expect(() => snapToGrid({ lat: 0, lng: 0 }, 0)).toThrow(RangeError)
    expect(() => snapToGrid({ lat: 0, lng: 0 }, -5)).toThrow(RangeError)
  })
})

describe('distanceMeters', () => {
  it('is zero for a point against itself', () => {
    expect(distanceMeters({ lat: 37.7749, lng: -122.4194 }, { lat: 37.7749, lng: -122.4194 })).toBe(
      0,
    )
  })

  it('measures a known city pair within a percent', () => {
    // San Francisco to New York is ~4129 km.
    const meters = distanceMeters({ lat: 37.7749, lng: -122.4194 }, { lat: 40.7128, lng: -74.006 })
    expect(meters / 1000).toBeGreaterThan(4090)
    expect(meters / 1000).toBeLessThan(4170)
  })

  it('measures a walkable hop in metres', () => {
    const meters = distanceMeters(
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7769, lng: -122.4194 },
    )
    expect(meters).toBeGreaterThan(200)
    expect(meters).toBeLessThan(240)
  })

  it('is symmetric', () => {
    const a = { lat: 51.5074, lng: -0.1278 }
    const b = { lat: 48.8566, lng: 2.3522 }
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6)
  })
})

describe('formatDistance', () => {
  it('uses feet up close and miles once feet stop meaning anything', () => {
    expect(formatDistance(40)).toBe('130 ft away')
    expect(formatDistance(METERS_PER_MILE / 2)).toBe('0.5 mi away')
    expect(formatDistance(METERS_PER_MILE)).toBe('1.0 mi away')
    expect(formatDistance(2 * METERS_PER_MILE)).toBe('2.0 mi away')
  })

  it('switches units exactly at a tenth of a mile', () => {
    // The boundary itself is the mile side, so no distance reads as both.
    expect(formatDistance(METERS_PER_MILE / 10)).toBe('0.1 mi away')
    expect(formatDistance(METERS_PER_MILE / 10 - 1)).toBe('520 ft away')
  })

  it('never says nought feet: two people standing together are still apart', () => {
    expect(formatDistance(0)).toBe('10 ft away')
    expect(formatDistance(1)).toBe('10 ft away')
  })
})

describe('formatMiles', () => {
  it('names the radius the way it is offered', () => {
    expect(formatMiles(DEFAULT_MATCH_RADIUS_METERS)).toBe('2 mi')
    expect(formatMiles(3 * METERS_PER_MILE)).toBe('3 mi')
    expect(formatMiles(METERS_PER_MILE * 1.5)).toBe('1.5 mi')
    expect(formatMiles(METERS_PER_MILE / 2)).toBe('0.5 mi')
  })
})

describe('the defaults the shard and the market fall back to', () => {
  it('derives the match radius from the mile rather than restating it', () => {
    expect(DEFAULT_MATCH_RADIUS_METERS).toBe(Math.round(2 * METERS_PER_MILE))
  })

  it('shards coarsely enough to contain the whole circle', () => {
    // The point of the precision: a buyer anywhere in a cell must be able to see
    // every candidate inside their radius, so the cell has to be much wider than
    // the circle's diameter. Precision 3 is ~156 km; the diameter is ~6.4 km.
    const cell = decodeCell(geohash(37.7749, -122.4194, DEFAULT_POOL_CELL_PRECISION))
    const widthMeters = distanceMeters(
      { lat: cell.latMin, lng: cell.lngMin },
      { lat: cell.latMin, lng: cell.lngMax },
    )
    expect(widthMeters).toBeGreaterThan(10 * 2 * DEFAULT_MATCH_RADIUS_METERS)
  })
})

import { describe, expect, it } from 'vitest'
import { distanceMeters, formatDistance, geohash } from '../shared/geo'

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
  it('uses metres up close and kilometres far away', () => {
    expect(formatDistance(120)).toBe('120 m away')
    expect(formatDistance(999)).toBe('999 m away')
    expect(formatDistance(1000)).toBe('1.0 km away')
    expect(formatDistance(1340)).toBe('1.3 km away')
  })
})

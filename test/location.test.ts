import { describe, expect, it } from 'vitest'
import { geohash } from '../shared/geo'
import {
  coordsSupplied,
  DEMO_ORIGIN,
  describeLocationSource,
  type LocationSource,
  parseCoords,
  parseLocationSource,
  resolveLocation,
} from '../shared/location'

const SOURCES: LocationSource[] = ['client', 'edge', 'demo']

describe('parseCoords', () => {
  it('accepts numbers', () => {
    expect(parseCoords({ lat: 37.7955, lng: -122.3937 })).toEqual({
      lat: 37.7955,
      lng: -122.3937,
    })
  })

  it('accepts the strings request.cf actually carries', () => {
    // `cf.latitude` and `cf.longitude` are strings, not numbers.
    expect(parseCoords({ lat: '37.7955', lng: '-122.3937' })).toEqual({
      lat: 37.7955,
      lng: -122.3937,
    })
  })

  it('treats a half pair as no pair', () => {
    expect(parseCoords({ lat: 37.7955 })).toBeNull()
    expect(parseCoords({ lng: -122.3937 })).toBeNull()
    expect(parseCoords({})).toBeNull()
    expect(parseCoords(null)).toBeNull()
    expect(parseCoords(undefined)).toBeNull()
  })

  it('refuses a blank string rather than reading it as the equator', () => {
    // Number('') is 0, which would silently place a buyer off the coast of Africa.
    expect(parseCoords({ lat: '', lng: '' })).toBeNull()
    expect(parseCoords({ lat: '   ', lng: '0' })).toBeNull()
  })

  it('refuses values out of range', () => {
    expect(parseCoords({ lat: 90.1, lng: 0 })).toBeNull()
    expect(parseCoords({ lat: 0, lng: -180.5 })).toBeNull()
    expect(parseCoords({ lat: '91', lng: '0' })).toBeNull()
  })

  it('refuses anything that is not a number or a numeric string', () => {
    expect(parseCoords({ lat: 'north', lng: 'west' })).toBeNull()
    expect(parseCoords({ lat: Number.NaN, lng: 0 })).toBeNull()
    expect(parseCoords({ lat: Number.POSITIVE_INFINITY, lng: 0 })).toBeNull()
    expect(parseCoords({ lat: true, lng: false })).toBeNull()
    expect(parseCoords({ lat: [37], lng: [-122] })).toBeNull()
    expect(parseCoords({ lat: { lat: 37 }, lng: 0 })).toBeNull()
    expect(parseCoords({ lat: null, lng: null })).toBeNull()
  })

  it('accepts the poles and the antimeridian exactly', () => {
    expect(parseCoords({ lat: -90, lng: 180 })).toEqual({ lat: -90, lng: 180 })
  })
})

describe('coordsSupplied', () => {
  it('separates "sent nothing" from "sent something unusable"', () => {
    expect(coordsSupplied(undefined)).toBe(false)
    expect(coordsSupplied({})).toBe(false)
    expect(coordsSupplied({ lat: undefined, lng: undefined })).toBe(false)
    // Present but unusable: a client bug, and worth saying so rather than
    // quietly filing the buyer under a different cell.
    expect(coordsSupplied({ lat: '', lng: '' })).toBe(true)
    expect(coordsSupplied({ lat: 'north', lng: 'west' })).toBe(true)
    expect(coordsSupplied({ lat: 37.7955 })).toBe(true)
  })
})

describe('resolveLocation', () => {
  const edge = { lat: '40.7128', lng: '-74.006' }
  const client = { lat: '37.7955', lng: '-122.3937' }

  it('prefers coordinates the buyer opted into supplying', () => {
    expect(resolveLocation(client, edge)).toEqual({
      lat: 37.7955,
      lng: -122.3937,
      source: 'client',
    })
  })

  it('falls to the edge when the client sent nothing — the promptless default', () => {
    expect(resolveLocation(null, edge)).toEqual({ lat: 40.7128, lng: -74.006, source: 'edge' })
    expect(resolveLocation({}, edge)).toEqual({ lat: 40.7128, lng: -74.006, source: 'edge' })
  })

  it('falls to the demo origin when there is no cf to read at all', () => {
    expect(resolveLocation(null, null)).toEqual({ ...DEMO_ORIGIN, source: 'demo' })
  })

  it('treats a partial or garbage cf as no cf at all', () => {
    // `cf` is untrusted and can be partial: latitude without longitude, empty
    // strings, or values from a region Cloudflare could not place.
    expect(resolveLocation(null, { lat: '40.7128' }).source).toBe('demo')
    expect(resolveLocation(null, { lat: '', lng: '' }).source).toBe('demo')
    expect(resolveLocation(null, { lat: '999', lng: '-74.006' }).source).toBe('demo')
    expect(resolveLocation(null, { lat: undefined, lng: undefined })).toEqual({
      ...DEMO_ORIGIN,
      source: 'demo',
    })
  })

  it('does not promote unusable client coordinates to the client rung', () => {
    expect(resolveLocation({ lat: 'north', lng: 'west' }, edge).source).toBe('edge')
    expect(resolveLocation({ lat: '91', lng: '0' }, null).source).toBe('demo')
  })

  it('uses the origin it is handed, so the last rung is genuinely a parameter', () => {
    const chicago = { lat: 41.8781, lng: -87.6298 }
    expect(resolveLocation(null, null, chicago)).toEqual({ ...chicago, source: 'demo' })
  })

  it('never returns a coordinate geohash would throw on', () => {
    // A RangeError inside the socket upgrade would reach the buyer as a
    // connection that simply breaks, so every rung has to be safe to encode.
    const hostile = [
      null,
      undefined,
      {},
      { lat: '', lng: '' },
      { lat: 'NaN', lng: 'NaN' },
      { lat: '1e400', lng: '0' },
      { lat: 90.0001, lng: 180.0001 },
      { lat: -1000, lng: 1000 },
      { lat: true, lng: {} },
      { lat: '  ', lng: '  ' },
    ]
    for (const client of hostile) {
      for (const edgeCoords of hostile) {
        const fix = resolveLocation(client, edgeCoords)
        expect(() => geohash(fix.lat, fix.lng, 6)).not.toThrow()
        expect(geohash(fix.lat, fix.lng, 6)).toHaveLength(6)
      }
    }
  })
})

describe('parseLocationSource', () => {
  it('round-trips every rung, and refuses anything else', () => {
    for (const source of SOURCES) expect(parseLocationSource(source)).toBe(source)
    expect(parseLocationSource(null)).toBeNull()
    expect(parseLocationSource('gps')).toBeNull()
    expect(parseLocationSource('CLIENT')).toBeNull()
    expect(parseLocationSource(1)).toBeNull()
  })
})

describe('describeLocationSource', () => {
  it('has wording for every rung', () => {
    for (const source of SOURCES) {
      const copy = describeLocationSource(source)
      expect(copy.label.length).toBeGreaterThan(0)
      expect(copy.detail.length).toBeGreaterThan(0)
    }
  })

  it('only claims an exact location on the rung that has one', () => {
    for (const source of SOURCES) {
      const copy = describeLocationSource(source)
      const claimsExact = /exact|precise/i.test(`${copy.label} ${copy.detail}`)
      expect(claimsExact).toBe(source === 'client')
    }
  })

  it('tells a buyer on the demo origin that the position is not theirs', () => {
    const copy = describeLocationSource('demo')
    expect(copy.label).toMatch(/demo/i)
    expect(copy.detail).toMatch(/not yours/i)
  })

  it('never names the shard on screen: a cell is not a unit anybody reads', () => {
    // Issue #82: the geohash cell is an implementation detail, and the market a
    // buyer is told about is a distance. If the word comes back into this copy it
    // is back on the screen, since this is the only place the rungs are worded.
    for (const source of SOURCES) {
      const copy = describeLocationSource(source)
      expect(`${copy.label} ${copy.detail}`).not.toMatch(/cell/i)
    }
  })
})

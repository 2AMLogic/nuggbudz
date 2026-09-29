import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEALS } from '../shared/deals'
import { DEFAULT_MATCH_RADIUS_METERS, distanceMeters, type LatLng } from '../shared/geo'
import { DEMO_ORIGIN } from '../shared/location'
import {
  brandForMerchant,
  describeStoresOnMap,
  MAX_STORES,
  overpassQuery,
  parseNearbyStores,
  parseOverpassElement,
  parseOverpassStores,
  parseStore,
  STORE_GRID_METERS,
  type Store,
  storeSearchPoint,
  storeSearchRadius,
  storesForMap,
  storesWithin,
} from '../shared/stores'
import app from '../worker/index'
import { lookupStores, OVERPASS_USER_AGENT, type StoreCache } from '../worker/lib/stores'

/**
 * Nothing in this file reaches Overpass. Every fetch is a stand-in that records
 * what would have been sent — a unit test that depended on a rate-limited public
 * server would be a flaky test and a bad neighbour at once.
 */

// The runtime's own fallback, not a typed figure: the deployed number lives in
// `wrangler.jsonc` alone, and these tests only need a two-mile market.
const RADIUS = DEFAULT_MATCH_RADIUS_METERS
const MCD = 'Q38076'

/** Two real McDonald's near the demo origin, as Overpass answered for #147. */
const MARKET_STREET = {
  type: 'node',
  id: 1001,
  lat: 37.7889505,
  lon: -122.4014996,
  tags: { name: "McDonald's", 'addr:housenumber': '609', 'addr:street': 'Market Street' },
}
const SUTTER_STREET = {
  type: 'way',
  id: 2002,
  center: { lat: 37.7892272, lon: -122.4077251 },
  tags: { name: "McDonald's", 'addr:street': 'Sutter Street' },
}

function overpassBody(elements: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 0.6, generator: 'Overpass API', elements, ...extra }
}

/** A KV stand-in: a Map, with every write recorded. */
function fakeCache() {
  const entries = new Map<string, string>()
  const puts: { key: string; ttl: number | undefined }[] = []
  const cache: StoreCache = {
    async get(key) {
      const raw = entries.get(key)
      return raw === undefined ? null : JSON.parse(raw)
    },
    async put(key, value, options) {
      entries.set(key, value)
      puts.push({ key, ttl: options?.expirationTtl })
    },
  }
  return { cache, entries, puts }
}

/** A fetch stand-in answering with `respond`, recording each call. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    // Yield first, so concurrent callers genuinely overlap the way a rush does.
    await new Promise((resolve) => setTimeout(resolve, 5))
    return respond()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const okJson = (body: unknown) => () => Response.json(body)

describe('parseOverpassElement', () => {
  it('reads a node, and a way by its centre', () => {
    expect(parseOverpassElement(MARKET_STREET)).toEqual({
      id: 'node/1001',
      name: "McDonald's",
      lat: 37.7889505,
      lng: -122.4014996,
      address: '609 Market Street',
    })
    expect(parseOverpassElement(SUTTER_STREET)).toEqual({
      id: 'way/2002',
      name: "McDonald's",
      lat: 37.7892272,
      lng: -122.4077251,
      address: 'Sutter Street',
    })
  })

  it('drops an element with no name, or a name that is only noise', () => {
    expect(parseOverpassElement({ ...MARKET_STREET, tags: {} })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, tags: undefined })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, tags: { name: '  ​‮ ' } })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, tags: { name: 42 } })).toBeNull()
  })

  it('drops an element with no position, or a position off the globe', () => {
    expect(parseOverpassElement({ ...MARKET_STREET, lat: undefined })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, lat: 91 })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, lon: -181 })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, lat: Number.NaN })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, lat: '' })).toBeNull()
    // A way without `out center` has no position of its own.
    expect(parseOverpassElement({ ...SUTTER_STREET, center: undefined })).toBeNull()
    // A node does not get to borrow a centre it should not have.
    expect(
      parseOverpassElement({ ...MARKET_STREET, lat: undefined, center: { lat: 1, lon: 1 } }),
    ).toBeNull()
  })

  it('drops an element that is not shaped like OSM', () => {
    expect(parseOverpassElement(null)).toBeNull()
    expect(parseOverpassElement('node/1')).toBeNull()
    expect(parseOverpassElement([MARKET_STREET])).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, type: 'area' })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, id: -1 })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, id: 1.5 })).toBeNull()
    expect(parseOverpassElement({ ...MARKET_STREET, id: '1001' })).toBeNull()
  })

  it('cleans the text a stranger typed into OSM', () => {
    const store = parseOverpassElement({
      ...MARKET_STREET,
      tags: { name: 'Mc‮Donald\u0000s\nDowntown', 'addr:street': 'x'.repeat(500) },
    })
    expect(store?.name).toBe('McDonalds Downtown')
    expect(store?.address?.length).toBe(80)
  })
})

describe('parseOverpassStores', () => {
  it('keeps the good elements and drops the rest', () => {
    const stores = parseOverpassStores(
      overpassBody([MARKET_STREET, { type: 'node', id: 3 }, SUTTER_STREET, 'junk', null]),
    )
    expect(stores?.map((store) => store.id)).toEqual(['node/1001', 'way/2002'])
  })

  it('answers an element seen twice once', () => {
    expect(parseOverpassStores(overpassBody([MARKET_STREET, MARKET_STREET]))).toHaveLength(1)
  })

  it('tells an empty market apart from a failed answer', () => {
    expect(parseOverpassStores(overpassBody([]))).toEqual([])
    expect(parseOverpassStores(null)).toBeNull()
    expect(parseOverpassStores('<html>rate limited</html>')).toBeNull()
    expect(parseOverpassStores({ elements: 'none' })).toBeNull()
    expect(parseOverpassStores({})).toBeNull()
    // Overpass gives up on a query with a 200 and a partial result.
    expect(
      parseOverpassStores(
        overpassBody([MARKET_STREET], { remark: 'runtime error: Query timed out in "query"' }),
      ),
    ).toBeNull()
  })
})

describe('the brand catalogue', () => {
  it('knows a brand for every merchant in the deal catalogue', () => {
    for (const deal of DEALS) expect(brandForMerchant(deal.merchant)).toMatch(/^Q[1-9]\d*$/)
  })

  it('knows nothing it was not told', () => {
    expect(brandForMerchant('Nugget Hut')).toBeNull()
    expect(brandForMerchant('__proto__')).toBeNull()
    expect(brandForMerchant('constructor')).toBeNull()
  })
})

describe('overpassQuery', () => {
  it('asks for the brand around the point, with a centre for every way', () => {
    const query = overpassQuery(MCD, { lat: 37.7955, lng: -122.3937 }, 4219)
    expect(query).toContain('nwr["brand:wikidata"="Q38076"](around:4219,37.795500,-122.393700)')
    expect(query).toContain('out center')
    expect(query).toContain('[out:json]')
  })

  it('refuses to build a program out of anything but a wikidata id', () => {
    expect(() => overpassQuery('Q1"];out;', DEMO_ORIGIN, 1000)).toThrow(RangeError)
    expect(() => overpassQuery(MCD, DEMO_ORIGIN, 0)).toThrow(RangeError)
  })
})

describe('the search grid', () => {
  it('covers every circle that snaps to the same point', () => {
    // Walk a grid of centres across a few cells, at two latitudes where a degree
    // of longitude is very different, and check each circle fits in its search.
    for (const base of [DEMO_ORIGIN, { lat: 60.17, lng: 24.94 }]) {
      for (let i = -10; i <= 10; i += 1) {
        for (let j = -10; j <= 10; j += 1) {
          const centre = { lat: base.lat + i * 0.0013, lng: base.lng + j * 0.0017 }
          const point = storeSearchPoint(centre)
          expect(distanceMeters(point, centre) + RADIUS).toBeLessThanOrEqual(
            storeSearchRadius(RADIUS),
          )
        }
      }
    }
  })

  it('is coarse enough that one venue is one point', () => {
    const a = storeSearchPoint(DEMO_ORIGIN)
    const b = storeSearchPoint({ lat: DEMO_ORIGIN.lat + 0.0001, lng: DEMO_ORIGIN.lng - 0.0001 })
    expect(b).toEqual(a)
    expect(STORE_GRID_METERS).toBeGreaterThanOrEqual(500)
  })
})

function store(id: number, at: LatLng): Store {
  return { id: `node/${id}`, name: `Store ${id}`, ...at, address: null }
}

describe('storesWithin', () => {
  it('keeps the circle, nearest first, and drops a nonsense position', () => {
    const near = store(1, { lat: DEMO_ORIGIN.lat + 0.001, lng: DEMO_ORIGIN.lng })
    const nearer = store(2, { lat: DEMO_ORIGIN.lat, lng: DEMO_ORIGIN.lng + 0.0001 })
    const outside = store(3, { lat: DEMO_ORIGIN.lat + 0.05, lng: DEMO_ORIGIN.lng })
    const nullIsland = store(4, { lat: 0, lng: 0 })
    expect(storesWithin([near, outside, nullIsland, nearer], DEMO_ORIGIN, RADIUS)).toEqual([
      nearer,
      near,
    ])
  })

  it('never hands back more than a map can show', () => {
    const many = Array.from({ length: MAX_STORES + 10 }, (_, i) =>
      store(i + 1, { lat: DEMO_ORIGIN.lat + i * 0.00001, lng: DEMO_ORIGIN.lng }),
    )
    expect(storesWithin(many, DEMO_ORIGIN, RADIUS)).toHaveLength(MAX_STORES)
  })
})

describe('storesForMap', () => {
  const inside = store(1, { lat: DEMO_ORIGIN.lat + 0.001, lng: DEMO_ORIGIN.lng })
  const nearby = (centre: LatLng, stores: Store[]) => ({
    centre,
    radiusMeters: RADIUS,
    merchant: "McDonald's",
    stores,
  })

  it('says nothing when nothing is known', () => {
    expect(storesForMap(null, DEMO_ORIGIN, RADIUS)).toBeNull()
  })

  it('states an empty market plainly when the search covered the circle', () => {
    expect(storesForMap(nearby(DEMO_ORIGIN, []), DEMO_ORIGIN, RADIUS)).toEqual({
      stores: [],
      complete: true,
    })
  })

  it('never lets a search around somewhere else claim the circle is empty', () => {
    // A buyer who turned on precise location is drawn where the server did not search.
    const elsewhere = { lat: DEMO_ORIGIN.lat + 0.01, lng: DEMO_ORIGIN.lng }
    expect(storesForMap(nearby(elsewhere, []), DEMO_ORIGIN, RADIUS)).toBeNull()
    expect(storesForMap(nearby(elsewhere, [inside]), DEMO_ORIGIN, RADIUS)).toEqual({
      stores: [inside],
      complete: false,
    })
  })

  it('treats a search over a smaller circle as partial', () => {
    const smaller = { ...nearby(DEMO_ORIGIN, []), radiusMeters: RADIUS - 1 }
    expect(storesForMap(smaller, DEMO_ORIGIN, RADIUS)).toBeNull()
  })
})

describe('describeStoresOnMap', () => {
  const one = [store(1, DEMO_ORIGIN)]
  it('counts, and only says "no" when it knows', () => {
    expect(describeStoresOnMap({ stores: [], complete: true }, "McDonald's", '2 mi')).toBe(
      "no McDonald's stores mapped within 2 mi",
    )
    expect(describeStoresOnMap({ stores: one, complete: true }, "McDonald's", '2 mi')).toBe(
      "1 McDonald's store mapped within 2 mi",
    )
    expect(describeStoresOnMap({ stores: one, complete: false }, "McDonald's", '2 mi')).toBe(
      "at least 1 McDonald's store mapped within 2 mi",
    )
  })
})

describe('parseStore and parseNearbyStores', () => {
  const good = { id: 'node/1', name: 'A', lat: 1, lng: 2, address: null }

  it('reads back what the Worker serves', () => {
    expect(parseStore(good)).toEqual(good)
    const body = {
      centre: DEMO_ORIGIN,
      radiusMeters: RADIUS,
      merchant: "McDonald's",
      stores: [good],
    }
    expect(parseNearbyStores(body)).toEqual(body)
  })

  it('refuses the shapes a tampered cache or response could take', () => {
    expect(parseStore({ ...good, id: 'node/1"><img>' })).toBeNull()
    expect(parseStore({ ...good, lat: 100 })).toBeNull()
    expect(parseStore({ ...good, name: '' })).toBeNull()
    expect(parseNearbyStores({ centre: DEMO_ORIGIN, radiusMeters: RADIUS, stores: [] })).toBeNull()
    expect(
      parseNearbyStores({ centre: null, radiusMeters: RADIUS, merchant: 'x', stores: [] }),
    ).toBeNull()
    expect(
      parseNearbyStores({ centre: DEMO_ORIGIN, radiusMeters: -1, merchant: 'x', stores: [] }),
    ).toBeNull()
    expect(
      parseNearbyStores({ centre: DEMO_ORIGIN, radiusMeters: RADIUS, merchant: 'x', stores: {} }),
    ).toBeNull()
  })
})

describe('lookupStores', () => {
  it('sends a User-Agent, since Overpass answers 406 without one', async () => {
    const { cache } = fakeCache()
    const { fetchImpl, calls } = fakeFetch(okJson(overpassBody([MARKET_STREET])))
    await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]?.init?.headers).get('User-Agent')).toBe(OVERPASS_USER_AGENT)
    expect(OVERPASS_USER_AGENT).toMatch(/NuggBudz/)
  })

  it('turns a rush at one venue into one upstream query', async () => {
    const { cache, puts } = fakeCache()
    const { fetchImpl, calls } = fakeFetch(okJson(overpassBody([MARKET_STREET, SUTTER_STREET])))
    // Twenty buyers a few metres apart, all asking before the first answer lands.
    const rush = Array.from({ length: 20 }, (_, i) =>
      lookupStores(
        { cache, fetchImpl },
        MCD,
        { lat: DEMO_ORIGIN.lat + i * 0.00001, lng: DEMO_ORIGIN.lng },
        RADIUS,
      ),
    )
    const answers = await Promise.all(rush)
    expect(calls).toHaveLength(1)
    expect(puts).toHaveLength(1)
    for (const answer of answers) expect(answer).toHaveLength(2)

    // And a buyer who arrives after it is answered from the cache.
    await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)
    expect(calls).toHaveLength(1)
  })

  it('searches the snapped point, widened, never the raw centre', async () => {
    const { cache } = fakeCache()
    const { fetchImpl, calls } = fakeFetch(okJson(overpassBody([])))
    await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)
    const sent = new URLSearchParams(String(calls[0]?.init?.body)).get('data')
    const point = storeSearchPoint(DEMO_ORIGIN)
    expect(sent).toBe(overpassQuery(MCD, point, storeSearchRadius(RADIUS)))
  })

  it('answers null when upstream is down, and does not ask again per client', async () => {
    for (const respond of [
      () => new Response('Too Many Requests', { status: 429 }),
      () => new Response('<html>busy</html>', { status: 200 }),
      () => Promise.reject(new TypeError('network down')),
      okJson(overpassBody([], { remark: 'runtime error: out of memory' })),
    ]) {
      const { cache, puts } = fakeCache()
      const { fetchImpl, calls } = fakeFetch(respond)
      expect(await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)).toBeNull()
      expect(await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)).toBeNull()
      expect(calls).toHaveLength(1)
      // Remembered briefly, not for the day a real answer is kept.
      expect(puts[0]?.ttl).toBeLessThanOrEqual(600)
    }
  })

  it('caches an empty market as an answer, not as a failure', async () => {
    const { cache, puts } = fakeCache()
    const { fetchImpl } = fakeFetch(okJson(overpassBody([])))
    expect(await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)).toEqual([])
    expect(puts[0]?.ttl).toBeGreaterThan(600)
  })

  it('treats a tampered cache entry as a miss', async () => {
    const { cache, entries } = fakeCache()
    const { fetchImpl, calls } = fakeFetch(okJson(overpassBody([MARKET_STREET])))
    await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)
    const [key] = [...entries.keys()]
    entries.set(String(key), JSON.stringify({ stores: 'everything' }))
    expect(await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it('still answers when the cache itself is failing', async () => {
    const cache: StoreCache = {
      get: () => Promise.reject(new Error('kv down')),
      put: () => Promise.reject(new Error('kv down')),
    }
    const { fetchImpl } = fakeFetch(okJson(overpassBody([MARKET_STREET])))
    expect(await lookupStores({ cache, fetchImpl }, MCD, DEMO_ORIGIN, RADIUS)).toHaveLength(1)
  })
})

describe('GET /api/stores', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function env() {
    return { SESSIONS: fakeCache().cache, MATCH_RADIUS_METERS: String(RADIUS) }
  }

  /** Stub the global fetch the route uses, and report the Overpass query it sent. */
  function stubOverpass(respond: () => Response | Promise<Response>) {
    const { fetchImpl, calls } = fakeFetch(respond)
    vi.stubGlobal('fetch', fetchImpl)
    return () => new URLSearchParams(String(calls.at(-1)?.init?.body)).get('data')
  }

  function request(path: string, cf?: Record<string, unknown>): Request {
    const req = new Request(`http://localhost${path}`)
    if (cf !== undefined) Object.defineProperty(req, 'cf', { value: cf })
    return req
  }

  it('centres on the server-resolved position and ignores coordinates it is sent', async () => {
    const sentQuery = stubOverpass(okJson(overpassBody([MARKET_STREET, SUTTER_STREET])))
    // Somewhere in London, which the caller would like to know about.
    const response = await app.request(
      request('/api/stores?dealId=mcd-nuggets-20&lat=51.5074&lng=-0.1278'),
      undefined,
      env(),
    )
    expect(response.status).toBe(200)
    const body = parseNearbyStores(await response.json())
    // No `cf` in a unit test, so the pool's own fallback applies: the demo origin.
    expect(body?.centre).toEqual(DEMO_ORIGIN)
    expect(body?.radiusMeters).toBe(RADIUS)
    expect(body?.stores.map((s) => s.id)).toEqual(['node/1001', 'way/2002'])
    expect(sentQuery()).toBe(
      overpassQuery(MCD, storeSearchPoint(DEMO_ORIGIN), storeSearchRadius(RADIUS)),
    )
    expect(sentQuery()).not.toContain('51.5')
  })

  it("uses the edge's position when the request carries one", async () => {
    const sentQuery = stubOverpass(okJson(overpassBody([])))
    const edge = { lat: 45.5231, lng: -122.6765 }
    const response = await app.request(
      request('/api/stores?dealId=mcd-nuggets-20&lat=0&lng=0', {
        latitude: String(edge.lat),
        longitude: String(edge.lng),
      }),
      undefined,
      env(),
    )
    const body = parseNearbyStores(await response.json())
    expect(body?.centre).toEqual(edge)
    expect(body?.stores).toEqual([])
    expect(sentQuery()).toBe(overpassQuery(MCD, storeSearchPoint(edge), storeSearchRadius(RADIUS)))
  })

  it('answers 503 when Overpass cannot, so the map simply draws no stores', async () => {
    stubOverpass(() => new Response('', { status: 504 }))
    const response = await app.request(
      request('/api/stores?dealId=mcd-nuggets-20'),
      undefined,
      env(),
    )
    expect(response.status).toBe(503)
    expect(parseNearbyStores(await response.json())).toBeNull()
  })

  it('refuses a deal that is not on offer without asking upstream', async () => {
    const sentQuery = stubOverpass(okJson(overpassBody([])))
    for (const dealId of ['', 'nope', 'wendys-nuggets-20']) {
      const response = await app.request(request(`/api/stores?dealId=${dealId}`), undefined, env())
      expect(response.status).toBe(404)
    }
    expect(sentQuery()).toBeNull()
  })
})

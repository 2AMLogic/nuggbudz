import type { LatLng } from '../../shared/geo'
import {
  OVERPASS_TIMEOUT_SECONDS,
  overpassQuery,
  parseOverpassStores,
  parseStoreList,
  type Store,
  storeSearchPoint,
  storeSearchRadius,
  storesCacheKey,
} from '../../shared/stores'

/** The public Overpass instance. `OVERPASS_URL` overrides it, e.g. to a dead host. */
export const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

/**
 * Who is asking. Overpass answers `406 Not Acceptable` to a request with no
 * `User-Agent` at all, and its usage policy asks that heavy callers be
 * identifiable — so this names the app and where to find it.
 */
export const OVERPASS_USER_AGENT = 'NuggBudz/0.1 (+https://github.com/2AMLogic/nuggbudz)'

/**
 * A found answer changes when a store opens or closes, which is months, so a
 * day is generous freshness and a small fraction of a KV free tier's writes.
 */
const FOUND_TTL_SECONDS = 24 * 60 * 60

/**
 * An upstream failure is cached too, briefly. Otherwise every buyer in a rush
 * would retry a rate-limited Overpass in turn — once per client, which is the one
 * shape this module exists to prevent. KV refuses anything under a minute.
 */
const FAILED_TTL_SECONDS = 5 * 60

/** The KV surface this needs — `SESSIONS` in the Worker, a Map in a test. */
export interface StoreCache {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface StoreLookupConfig {
  cache: StoreCache
  fetchImpl?: typeof fetch
  overpassUrl?: string
}

/**
 * Searches in flight in this isolate, by cache key.
 *
 * KV is not a lock: a burst that arrives before the first answer is written would
 * all miss and all go upstream. Joining the one promise already in flight is what
 * makes that burst a single query, at least within an isolate — and a rush at one
 * venue arrives at one colo.
 */
const inflight = new Map<string, Promise<Store[] | null>>()

/**
 * Every store of `brand` that could be inside a circle of `radiusMeters` around
 * `centre`, or null when that cannot be answered right now.
 *
 * Not yet filtered to the circle: the search is centred on a coarse grid point so
 * that it can be shared, and the caller cuts it down to one buyer's circle with
 * `storesWithin`. Never throws — a store list is decoration on a map, and pairing
 * must not come to depend on a third party being up.
 */
export async function lookupStores(
  config: StoreLookupConfig,
  brand: string,
  centre: LatLng,
  radiusMeters: number,
): Promise<Store[] | null> {
  const point = storeSearchPoint(centre)
  const searchRadius = storeSearchRadius(radiusMeters)
  const key = storesCacheKey(brand, point, searchRadius)

  const cached = await readCache(config.cache, key)
  if (cached !== undefined) return cached

  const pending = inflight.get(key)
  if (pending !== undefined) return pending

  const search = (async () => {
    const stores = await fetchStores(config, overpassQuery(brand, point, searchRadius))
    await writeCache(config.cache, key, stores)
    return stores
  })().finally(() => inflight.delete(key))
  inflight.set(key, search)
  return search
}

/** A cached answer: a list, a remembered failure (null), or undefined for a miss. */
async function readCache(cache: StoreCache, key: string): Promise<Store[] | null | undefined> {
  const entry: unknown = await cache.get(key, 'json').catch(() => null)
  if (typeof entry !== 'object' || entry === null) return undefined
  if ((entry as { unavailable?: unknown }).unavailable === true) return null
  // A malformed entry is a miss rather than an answer; the next search overwrites it.
  return parseStoreList((entry as { stores?: unknown }).stores) ?? undefined
}

async function writeCache(cache: StoreCache, key: string, stores: Store[] | null): Promise<void> {
  const [value, expirationTtl] =
    stores === null ? [{ unavailable: true }, FAILED_TTL_SECONDS] : [{ stores }, FOUND_TTL_SECONDS]
  // A failed write costs the next buyer one more upstream query, nothing more.
  await cache.put(key, JSON.stringify(value), { expirationTtl }).catch(() => undefined)
}

async function fetchStores(config: StoreLookupConfig, query: string): Promise<Store[] | null> {
  const fetchImpl = config.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(config.overpassUrl ?? DEFAULT_OVERPASS_URL, {
      method: 'POST',
      headers: {
        'User-Agent': OVERPASS_USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ data: query }).toString(),
      // A little past the server-side timeout in the query, so Overpass gets to
      // say it gave up rather than being cut off mid-answer.
      signal: AbortSignal.timeout((OVERPASS_TIMEOUT_SECONDS + 2) * 1000),
    })
    if (!response.ok) return null
    const body: unknown = await response.json().catch(() => null)
    return parseOverpassStores(body)
  } catch {
    return null
  }
}

import { distanceMeters, type LatLng, snapToGrid } from './geo'
import { parseCoords } from './location'
import { sanitizeDisplayText } from './text'

/**
 * Where a matched pair could actually go: the chain's stores inside the market.
 *
 * The data is OpenStreetMap's, fetched through Overpass by the Worker — never by
 * the browser, which would be handing a third party the buyer's position and
 * spending a rate limit that belongs to everybody. It is the same source as the
 * basemap under it, so the dots and the tiles share one licence and one
 * attribution line.
 *
 * Everything that arrives from Overpass is hostile in exactly the way a socket
 * message is: it is parsed here, element by element, and whatever does not come
 * out as a named place with a real position inside the circle it was asked for
 * is dropped rather than drawn.
 */

/** One store, as the Worker hands it to the client. */
export interface Store {
  /** OSM's own identity, e.g. `node/123` — stable, and never shown. */
  id: string
  name: string
  lat: number
  lng: number
  /** Street address when OSM has one, e.g. `609 Market Street`. */
  address: string | null
}

/**
 * The OSM brand each merchant's stores are tagged with (`brand:wikidata`).
 *
 * Keyed by the merchant string in `shared/deals.ts`, like the sauce catalogue, so
 * the chain a deal names is the only thing that decides whose stores are drawn.
 * `brand:wikidata` rather than `name` because a name match would find every
 * restaurant with the chain's name in it; the brand tag is what OSM's own
 * name-suggestion index maintains per chain.
 */
export const STORE_BRANDS: Readonly<Record<string, string>> = {
  "McDonald's": 'Q38076',
  "Wendy's": 'Q550258',
  'Burger King': 'Q177054',
}

/** The brand tag for a merchant's stores, or null when the catalogue has none. */
export function brandForMerchant(merchant: string): string | null {
  const brand = Object.hasOwn(STORE_BRANDS, merchant) ? STORE_BRANDS[merchant] : undefined
  return brand !== undefined && WIKIDATA_ID.test(brand) ? brand : null
}

const WIKIDATA_ID = /^Q[1-9][0-9]*$/

/**
 * The grid a search centre is snapped to before anything upstream is asked.
 *
 * This is the cache's granularity, and it is what makes a rush at one venue one
 * Overpass query rather than one per buyer: every centre within half a step of a
 * grid point shares that point's answer. The search is then widened by a whole
 * step (see `storeSearchRadius`), which more than covers the ~0.71 step a snapped
 * point can sit from the centre it stands for, so no buyer's circle is clipped by
 * somebody else's rounding.
 */
export const STORE_GRID_METERS = 1_000

/** Never more dots than this, nearest first. A map this small cannot show more. */
export const MAX_STORES = 40

/** A store name or address is a label on a map, not a paragraph. */
const STORE_TEXT_MAX = 80

/** Where the upstream search is centred for a buyer at `centre`. */
export function storeSearchPoint(centre: LatLng): LatLng {
  return snapToGrid(centre, STORE_GRID_METERS)
}

/** How far the upstream search reaches, so every circle snapped to it is covered. */
export function storeSearchRadius(radiusMeters: number): number {
  return Math.ceil(radiusMeters + STORE_GRID_METERS)
}

/**
 * The cache key for one search. Coarse on purpose — see `STORE_GRID_METERS`.
 *
 * The radius is part of it so that repricing the market in `wrangler.jsonc`
 * cannot serve a smaller circle's answer for a larger one.
 */
export function storesCacheKey(brand: string, point: LatLng, searchRadiusMeters: number): string {
  return `stores:v1:${brand}:${searchRadiusMeters}:${point.lat.toFixed(5)},${point.lng.toFixed(5)}`
}

/** Seconds the upstream answer is allowed to take, stated inside the query too. */
export const OVERPASS_TIMEOUT_SECONDS = 10

/**
 * The Overpass QL for one search.
 *
 * `nwr` because a store is as often mapped as a building outline (a way) as a
 * point, and `out center` so a way comes back with one position rather than a
 * list of node ids. The brand is checked again here, not only at the catalogue,
 * because this string is a program another server will run.
 */
export function overpassQuery(brand: string, point: LatLng, searchRadiusMeters: number): string {
  if (!WIKIDATA_ID.test(brand)) throw new RangeError(`not a wikidata id: ${brand}`)
  const radius = Math.ceil(searchRadiusMeters)
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError(`search radius must be positive, got ${searchRadiusMeters}`)
  }
  const at = `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`
  return (
    `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];` +
    `nwr["brand:wikidata"="${brand}"](around:${radius},${at});` +
    `out center ${MAX_STORES * 2};`
  )
}

const ELEMENT_TYPES = new Set(['node', 'way', 'relation'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function storeText(raw: unknown): string | null {
  const text = sanitizeDisplayText(raw, STORE_TEXT_MAX)
  return text.length > 0 ? text : null
}

/**
 * One Overpass element, narrowed to a store, or null.
 *
 * A node carries its position as `lat`/`lon`; a way or relation asked for with
 * `out center` carries it under `center`. No name, no position, a position off
 * the globe or an id that is not OSM's shape — dropped, never guessed at. The
 * name goes through the one sanitizer for untrusted display text, because an OSM
 * tag is typed by a stranger exactly as a chat line is.
 */
export function parseOverpassElement(raw: unknown): Store | null {
  const element = asRecord(raw)
  if (element === null) return null

  const type = element.type
  const osmId = element.id
  if (typeof type !== 'string' || !ELEMENT_TYPES.has(type)) return null
  if (typeof osmId !== 'number' || !Number.isSafeInteger(osmId) || osmId <= 0) return null

  const center = asRecord(element.center)
  const position =
    type === 'node'
      ? parseCoords({ lat: element.lat, lng: element.lon })
      : parseCoords({ lat: center?.lat, lng: center?.lon })
  if (position === null) return null

  const tags = asRecord(element.tags)
  const name = storeText(tags?.name)
  if (name === null) return null

  const street = storeText(tags?.['addr:street'])
  const number = storeText(tags?.['addr:housenumber'])
  const address = street === null ? null : number === null ? street : `${number} ${street}`

  return { id: `${type}/${osmId}`, name, ...position, address }
}

/**
 * A whole Overpass response, narrowed to its stores, or null when it is not one.
 *
 * Null is not "no stores". A body with no `elements` array, or one that carries a
 * runtime-error `remark` (Overpass answers a query it gave up on with a 200 and a
 * partial result), is an upstream failure — caching it as an empty market would
 * tell a buyer standing next to a store that there is none.
 */
export function parseOverpassStores(body: unknown): Store[] | null {
  const response = asRecord(body)
  if (response === null || !Array.isArray(response.elements)) return null
  if (typeof response.remark === 'string' && /error/i.test(response.remark)) return null
  return uniqueStores(response.elements.map(parseOverpassElement))
}

function uniqueStores(candidates: readonly (Store | null)[]): Store[] {
  const seen = new Set<string>()
  const stores: Store[] = []
  for (const store of candidates) {
    if (store === null || seen.has(store.id)) continue
    seen.add(store.id)
    stores.push(store)
  }
  return stores
}

/**
 * A store in the shape this app itself serves, or null.
 *
 * The same caution on the way back in: a KV entry is only as trustworthy as
 * whatever last wrote it, and the client should not draw a dot because a
 * response merely had the right keys.
 */
export function parseStore(raw: unknown): Store | null {
  const store = asRecord(raw)
  if (store === null) return null
  const id = store.id
  if (typeof id !== 'string' || !/^(node|way|relation)\/[1-9][0-9]*$/.test(id)) return null
  const position = parseCoords({ lat: store.lat, lng: store.lng })
  const name = storeText(store.name)
  if (position === null || name === null) return null
  const address = store.address === null ? null : storeText(store.address)
  return { id, name, ...position, address }
}

/** A list of this app's stores, or null when it is not a list. */
export function parseStoreList(raw: unknown): Store[] | null {
  if (!Array.isArray(raw)) return null
  return uniqueStores(raw.map(parseStore))
}

/**
 * The stores inside one buyer's circle, nearest first and capped.
 *
 * This is the filter that makes a nonsense position harmless: the search was
 * wider than the circle (see `storeSearchRadius`), and a store tagged at the
 * wrong end of the earth is simply not within `radiusMeters` of anybody.
 */
export function storesWithin(
  stores: readonly Store[],
  centre: LatLng,
  radiusMeters: number,
): Store[] {
  return stores
    .map((store) => ({ store, distance: distanceMeters(centre, store) }))
    .filter(({ distance }) => distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance || a.store.id.localeCompare(b.store.id))
    .slice(0, MAX_STORES)
    .map(({ store }) => store)
}

/** What the map may say about stores; see `storesForMap`. */
export interface StoresOnMap {
  stores: Store[]
  complete: boolean
}

/**
 * The stores on the map in words, for the caption and the screen-reader label.
 *
 * Only a complete search may say "no": an empty market is stated plainly rather
 * than implied, and a partial one is never allowed to imply the rest is empty.
 * OpenStreetMap is the source and says so on the same panel, so "mapped" is the
 * honest verb — a store OSM does not know about is not one the map can promise.
 */
export function describeStoresOnMap(view: StoresOnMap, merchant: string, within: string): string {
  const count = view.stores.length
  const noun = count === 1 ? 'store' : 'stores'
  if (!view.complete) return `at least ${count} ${merchant} ${noun} mapped within ${within}`
  if (count === 0) return `no ${merchant} stores mapped within ${within}`
  return `${count} ${merchant} ${noun} mapped within ${within}`
}

/** What `GET /api/stores` answers with. */
export interface NearbyStores {
  /** The position the stores were searched around — the server's, never the caller's. */
  centre: LatLng
  radiusMeters: number
  merchant: string
  stores: Store[]
}

/** The stores endpoint's answer, narrowed, or null when it is not one. */
export function parseNearbyStores(body: unknown): NearbyStores | null {
  const response = asRecord(body)
  if (response === null) return null
  const centre = parseCoords(asRecord(response.centre))
  const radiusMeters = response.radiusMeters
  const merchant = storeText(response.merchant)
  const stores = parseStoreList(response.stores)
  if (centre === null || merchant === null || stores === null) return null
  if (typeof radiusMeters !== 'number' || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return null
  }
  return { centre, radiusMeters, merchant, stores }
}

/**
 * Tolerance for "the stores were searched around the centre the map is drawn at".
 *
 * Both are resolved by the server from the same request metadata, so on the edge
 * and demo rungs they agree exactly; this only absorbs a float's round trip.
 */
const SAME_CENTRE_METERS = 1

/**
 * What the map may honestly draw, given the stores answer and where it is centred.
 *
 * - `null` — nothing is known about this circle, so the map says nothing about
 *   stores at all, exactly as it did before there were any.
 * - `complete: true` — the search covered the whole circle, so an empty list is a
 *   fact the map can state.
 * - `complete: false` — the buyer turned on precise location, so the map is centred
 *   somewhere the server did not search around. The stores that fall inside the
 *   circle are still real and still drawn, but an absence there proves nothing,
 *   and an empty partial answer is reported as unknown rather than as none.
 */
export function storesForMap(
  nearby: NearbyStores | null,
  you: LatLng,
  radiusMeters: number,
): StoresOnMap | null {
  if (nearby === null) return null
  const stores = storesWithin(nearby.stores, you, radiusMeters)
  const complete =
    distanceMeters(nearby.centre, you) <= SAME_CENTRE_METERS && nearby.radiusMeters >= radiusMeters
  if (!complete && stores.length === 0) return null
  return { stores, complete }
}

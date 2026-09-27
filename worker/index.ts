import { Hono } from 'hono'
import { DEALS, findDeal } from '../shared/deals'
import { analyzeSpread, settle } from '../shared/economics'
import { geohash } from '../shared/geo'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { type Env, intVar } from './env'

export { NuggPool } from './pool'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true, service: 'nuggbudz', protocol: PROTOCOL_VERSION }))

/** The deal catalogue, each with its settlement and the spread it arbitrages. */
app.get('/api/deals', (c) =>
  c.json({
    deals: DEALS.map((deal) => ({
      ...deal,
      settlement: settle(deal),
      spread: analyzeSpread(deal),
    })),
  }),
)

app.get('/api/deals/:dealId/quote', (c) => {
  const deal = findDeal(c.req.param('dealId'))
  if (deal === undefined) return c.json({ error: 'unknown deal' }, 404)

  const rawParty = c.req.query('partySize')
  const partySize = rawParty === undefined ? deal.partySize : Number.parseInt(rawParty, 10)
  if (!Number.isInteger(partySize) || partySize < 2 || partySize > deal.bulk.pieces) {
    return c.json({ error: 'partySize must be an integer between 2 and the piece count' }, 400)
  }

  return c.json({
    deal,
    settlement: settle(deal, partySize),
    spread: analyzeSpread(deal, partySize),
  })
})

/**
 * Upgrade to the matching socket for the caller's neighbourhood.
 *
 * The cell is derived from the supplied coordinates server-side rather than
 * accepted from the client, so a caller cannot park themselves in someone
 * else's market by naming an arbitrary cell.
 */
app.get('/api/pool/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('expected a websocket upgrade', 426)
  }

  const lat = Number(c.req.query('lat'))
  const lng = Number(c.req.query('lng'))
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return c.json({ error: 'lat must be a number in -90..90' }, 400)
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return c.json({ error: 'lng must be a number in -180..180' }, 400)
  }

  const cell = geohash(lat, lng, intVar(c.env.POOL_CELL_PRECISION, 6))
  const stub = c.env.NUGG_POOL.get(c.env.NUGG_POOL.idFromName(cell))

  const url = new URL(c.req.url)
  url.searchParams.set('cell', cell)
  return stub.fetch(new Request(url, c.req.raw))
})

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

export default app

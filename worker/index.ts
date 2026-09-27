import { Hono } from 'hono'
import { DEALS, findDeal } from '../shared/deals'
import { analyzeSpread, settle } from '../shared/economics'
import { geohash } from '../shared/geo'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { authRoutes, sessionFromRequest } from './auth'
import { type Env, intVar } from './env'

export { NuggPool } from './pool'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true, service: 'nuggbudz', protocol: PROTOCOL_VERSION }))

app.route('/api/auth', authRoutes)

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

/**
 * Platform-wide totals off the D1 ledger, not the live Durable Objects — the
 * whole point of settling to D1 is that this can answer without waking a
 * single cell. Every number is computed in SQL rather than summed in JS, so
 * the totals cannot drift from what a direct query against `matches` /
 * `match_buyers` would show.
 */
app.get('/api/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM matches WHERE settled_at IS NOT NULL) AS splits_settled,
       (SELECT COALESCE(SUM(platform_fee_cents), 0) FROM matches WHERE settled_at IS NOT NULL)
         AS fees_collected_cents,
       (SELECT COALESCE(SUM(b.solo_baseline_cents - b.pay_cents), 0)
          FROM match_buyers b
          JOIN matches m ON m.match_id = b.match_id
          WHERE m.settled_at IS NOT NULL) AS total_saved_cents`,
  ).first<{ splits_settled: number; fees_collected_cents: number; total_saved_cents: number }>()

  return c.json({
    splitsSettled: row?.splits_settled ?? 0,
    totalSavedCents: row?.total_saved_cents ?? 0,
    feesCollectedCents: row?.fees_collected_cents ?? 0,
  })
})

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
 * Two things are decided here and never by the client: who you are, from your
 * session cookie, and which cell you are in, from your coordinates. A caller
 * who could name their own cell would park themselves in someone else's market;
 * a caller who could name themselves would show a stranger any name they liked.
 */
app.get('/api/pool/ws', async (c) => {
  const active = await sessionFromRequest(c.env, c.req.raw)
  if (active === null) return c.json({ error: 'sign in required' }, 401)

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

  // `set` replaces any same-named parameter the caller supplied, so these three
  // reach the Durable Object with server-derived values only.
  const url = new URL(c.req.url)
  url.searchParams.set('cell', cell)
  url.searchParams.set('userId', active.session.userId)
  url.searchParams.set('displayName', active.session.displayName)
  return stub.fetch(new Request(url, c.req.raw))
})

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

export default app

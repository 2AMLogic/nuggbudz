import { Hono } from 'hono'
import { DEALS, findDeal } from '../shared/deals'
import { demoPairingEnabled, demoUserId, sanitizeDemoName } from '../shared/demo'
import { analyzeSpread, settle } from '../shared/economics'
import { geohash } from '../shared/geo'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { clientKey as deriveClientKey } from '../shared/ratelimit'
import { authRoutes, sessionFromRequest } from './auth'
import { type Env, intVar } from './env'
import { checkUpgradeRate } from './ratelimit'

export { NuggPool } from './pool'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'nuggbudz',
    protocol: PROTOCOL_VERSION,
    // The client reads this to offer a name field instead of a sign-in button
    // that cannot work, and to say on screen that it is pairing without accounts.
    demoPairing: demoPairingEnabled(c.env.ALLOW_DEMO_PAIRING),
  }),
)

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
  const demoAllowed = demoPairingEnabled(c.env.ALLOW_DEMO_PAIRING)
  if (active === null && !demoAllowed) {
    return c.json({ error: 'sign in required' }, 401)
  }

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

  // Cloudflare sets CF-Connecting-IP at the edge and a caller cannot override
  // it, unlike X-Forwarded-For. Local dev may omit it; those share one bucket.
  const clientKey = deriveClientKey(c.req.header('CF-Connecting-IP')) ?? 'unknown'

  // Checked here, before the pool is addressed, so a flood costs a KV read and
  // no Durable Object time. It runs after the session check so an
  // unauthenticated flood is turned away without touching the limiter's keys.
  const rate = await checkUpgradeRate(c.env, clientKey)
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds))
    return c.json({ error: 'too many connection attempts, slow down' }, 429)
  }

  const cell = geohash(lat, lng, intVar(c.env.POOL_CELL_PRECISION, 6))
  const stub = c.env.NUGG_POOL.get(c.env.NUGG_POOL.idFromName(cell))

  // `set` replaces any same-named parameter the caller supplied, so these three
  // reach the Durable Object with server-derived values only.
  const url = new URL(c.req.url)
  // Identity is the session when there is one, and a throwaway otherwise. A demo
  // caller may propose a display name but never a user id: minting the id here is
  // what keeps two tabs from claiming one identity, and therefore what keeps the
  // self-match guard meaningful.
  const identity =
    active !== null
      ? { userId: active.session.userId, displayName: active.session.displayName }
      : {
          userId: demoUserId(crypto.randomUUID()),
          displayName: sanitizeDemoName(c.req.query('name')),
        }

  url.searchParams.set('cell', cell)
  url.searchParams.set('userId', identity.userId)
  url.searchParams.set('displayName', identity.displayName)
  return stub.fetch(new Request(url, c.req.raw))
})

/**
 * Aggregate platform stats, computed in SQL rather than fetched-and-reduced —
 * these numbers only ever get more rows, and D1 is much better at summing
 * millions of them than the Worker is.
 */
app.get('/api/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS splits_settled,
       COALESCE(SUM(platform_fee_cents), 0) AS fees_collected_cents,
       COALESCE((
         SELECT SUM(mb.solo_baseline_cents - mb.pay_cents)
         FROM match_buyers mb
         JOIN matches m ON m.match_id = mb.match_id
         WHERE m.settled_at IS NOT NULL
       ), 0) AS total_saved_cents
     FROM matches
     WHERE settled_at IS NOT NULL`,
  ).first<{ splits_settled: number; fees_collected_cents: number; total_saved_cents: number }>()

  return c.json({
    splitsSettled: row?.splits_settled ?? 0,
    totalSavedCents: row?.total_saved_cents ?? 0,
    feesCollectedCents: row?.fees_collected_cents ?? 0,
  })
})

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

export default app

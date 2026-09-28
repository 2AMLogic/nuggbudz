import { Hono } from 'hono'
import { bytesToBase64Url } from '../shared/base64url'
import { ACTIVE_DEALS, findDeal, isDealOffered } from '../shared/deals'
import {
  DEMO_TOKEN_LENGTH,
  demoCookie,
  demoPairingEnabled,
  demoTokenFromCookieHeader,
  demoUserId,
  sanitizeDemoName,
} from '../shared/demo'
import { analyzeSpread, settle } from '../shared/economics'
import { DEFAULT_POOL_CELL_PRECISION, geohash } from '../shared/geo'
import {
  coordsSupplied,
  DEMO_ORIGIN,
  parseCoords,
  type RawCoords,
  resolveLocation,
} from '../shared/location'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { clientKey as deriveClientKey } from '../shared/ratelimit'
import { adminRoutes } from './admin'
import { authRoutes, sessionFromRequest } from './auth'
import { boolVar, type Env, intVar, stripeConfigured } from './env'
import { type PaymentOutcomeRequest, serverPaymentMode } from './lib/payments'
import { parsePaymentEvent, verifyStripeSignature } from './lib/stripe'
import { INTERNAL_PAYMENT_PATH } from './pool'
import { checkUpgradeRate } from './ratelimit'
import { sauceRoutes } from './sauces'

export { NuggPool } from './pool'

const app = new Hono<{ Bindings: Env }>()

/**
 * A demo token: 32 random bytes, base64url. `DEMO_TOKEN_LENGTH` is the length
 * that produces, and `isDemoTokenShaped` is what checks it on the way back in.
 */
function mintDemoToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = bytesToBase64Url(bytes)
  if (token.length !== DEMO_TOKEN_LENGTH) {
    throw new Error(`demo token is ${token.length} characters, expected ${DEMO_TOKEN_LENGTH}`)
  }
  return token
}

/** Whether this request arrived over TLS, which is what `Secure` should follow. */
function isSecureRequest(url: string): boolean {
  return new URL(url).protocol === 'https:'
}

app.get('/api/health', (c) => {
  const demoAllowed = demoPairingEnabled(c.env.ALLOW_DEMO_PAIRING)

  /**
   * The demo identity is handed out here, and here is not an accident.
   *
   * It cannot be minted on the socket upgrade, which is where it is *used*: a
   * `Set-Cookie` on a 101 response is not reliably stored by every browser, and
   * a cookie silently dropped would look exactly like having no sticky identity
   * — which is the failure this whole mechanism exists to prevent. It has to be
   * a plain HTTP response, and this is the one every client already fetches
   * before it can connect: the answer that says whether demo pairing is on is
   * the answer that hands you your demo identity. Minted only when the server
   * actually pairs without accounts, and only when the caller has no usable one
   * already, so a curl or a monitor gets a cookie it will ignore and nothing
   * else changes.
   */
  if (demoAllowed && demoTokenFromCookieHeader(c.req.header('Cookie')) === null) {
    c.header('Set-Cookie', demoCookie(mintDemoToken(), { secure: isSecureRequest(c.req.url) }))
  }

  return c.json({
    ok: true,
    service: 'nuggbudz',
    protocol: PROTOCOL_VERSION,
    // The client reads this to offer a name field instead of a sign-in button
    // that cannot work, and to say on screen that it is pairing without accounts.
    demoPairing: demoAllowed,
    /**
     * Whether this server can charge for a match, and therefore whether it will
     * make one at all. Stated out loud so an operator can check a deploy with a
     * single curl — `unconfigured` on a public URL means pairing is refused, not
     * that it is quietly free — and so `scripts/payment-gate-check.mjs` can
     * assert which side of the gate it is talking to before trusting anything it
     * observes.
     */
    payments: serverPaymentMode({
      stripeConfigured: stripeConfigured(c.env),
      unchargedAllowed: boolVar(c.env.ALLOW_UNCHARGED_PAIRING),
    }),
    /**
     * Whether the Stripe calls go to Stripe. `payments: "live"` says both secrets
     * are bound; it says nothing about *where* the charges are sent, and
     * `STRIPE_API_BASE` exists precisely to send them somewhere else. Repointing
     * it takes deploy-equivalent credentials, so this is observability rather
     * than a gate — but #74's whole premise is that a deploy-time var that fails
     * silently is a var nobody notices, and this was the one var the readback
     * could not see. `post-deploy-mode.mjs` exits non-zero on "custom".
     */
    stripeApiBase:
      c.env.STRIPE_API_BASE === undefined || c.env.STRIPE_API_BASE.length === 0
        ? 'default'
        : 'custom',
  })
})

app.route('/api/auth', authRoutes)

// A signed-in buyer's sauce pair. Mounted before the `/api/*` catch-all below,
// which Hono would otherwise match first.
app.route('/api', sauceRoutes)

// The operator surface: disputed pickups, and resolving one. Behind a session
// *and* the `OPERATOR_USER_IDS` allowlist — with the var unset there are no
// operators, and every route here answers exactly the same 404 the catch-all
// below does. See `worker/admin.ts`.
app.route('/api/admin', adminRoutes)

/** The deal catalogue, each with its settlement and the spread it arbitrages. */
// Only the deals the app currently offers — see INACTIVE_DEAL_IDS in
// shared/deals.ts. The catalogue itself stays whole.
app.get('/api/deals', (c) =>
  c.json({
    deals: ACTIVE_DEALS.map((deal) => ({
      ...deal,
      settlement: settle(deal),
      spread: analyzeSpread(deal),
    })),
  }),
)

app.get('/api/deals/:dealId/quote', (c) => {
  // A gated deal exists in the catalogue but is not on offer, so it must 404
  // exactly like one that does not exist — quoting a price for a chain the app
  // will not pair you on is an invitation to a dead end.
  const deal = findDeal(c.req.param('dealId'))
  if (deal === undefined || !isDealOffered(deal.id)) {
    return c.json({ error: 'unknown deal' }, 404)
  }

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
 * The approximate location Cloudflare attached to this request, if any.
 *
 * `cf` can be missing entirely, and its `latitude`/`longitude` are strings that
 * may individually be absent — miniflare caches a real one for local dev, but an
 * offline one has no coordinates in it. So this hands back raw values for
 * `resolveLocation` to validate rather than trusting them. Nothing here is more
 * trustworthy than a query parameter: it is simply cheaper and promptless.
 */
function edgeCoords(request: Request): RawCoords | null {
  const cf: unknown = request.cf
  if (cf === null || typeof cf !== 'object') return null
  const { latitude, longitude } = cf as { latitude?: unknown; longitude?: unknown }
  return { lat: latitude, lng: longitude }
}

/**
 * Upgrade to the matching socket for the caller's neighbourhood.
 *
 * Two things are decided here and never by the client: who you are, from your
 * session cookie, and which cell you are in, from a location this Worker
 * resolves. A caller who could name their own cell would park themselves in
 * someone else's market; a caller who could name themselves would show a
 * stranger any name they liked.
 *
 * The location has three rungs (see `shared/location.ts`), and the default one
 * needs no permission prompt at all: coordinates arrive only if the buyer turned
 * on precise location, otherwise the edge's guess is used, otherwise the demo
 * origin. So a phone with location denied still pairs.
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

  // Rung 1, and opt-in only. Sending nothing is the normal case, so absence is
  // not an error — but coordinates that are present and unusable are a client
  // bug, and answering that by quietly filing the buyer under a different cell
  // would be a worse answer than saying so.
  const clientCoords: RawCoords = { lat: c.req.query('lat'), lng: c.req.query('lng') }
  if (coordsSupplied(clientCoords) && parseCoords(clientCoords) === null) {
    return c.json({ error: 'lat must be in -90..90 and lng in -180..180' }, 400)
  }

  // Cloudflare sets CF-Connecting-IP at the edge and a caller cannot override
  // it, unlike X-Forwarded-For. Local dev may omit it; those share one bucket.
  const clientKey = deriveClientKey(c.req.header('CF-Connecting-IP')) ?? 'unknown'

  // Checked here, before the pool is addressed, so a flood costs a KV read and
  // no Durable Object time. Outside demo mode, an unauthenticated flood never
  // reaches this line — the session check above refuses it first. In demo mode
  // an unauthenticated caller does reach the limiter, which stays safe because
  // it keys on `clientKey` (from `CF-Connecting-IP`), not on user id: minting a
  // fresh `demo:<uuid>` per socket does not buy a new bucket.
  const rate = await checkUpgradeRate(c.env, clientKey)
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds))
    return c.json({ error: 'too many connection attempts, slow down' }, 429)
  }

  // Every rung is range-checked, so `geohash` cannot be reached with an argument
  // that would make it throw — a RangeError inside an upgrade would reach the
  // buyer as a socket that just breaks.
  const fix = resolveLocation(clientCoords, edgeCoords(c.req.raw), DEMO_ORIGIN)
  // The shard, not the market: it only has to be coarse enough to contain every
  // buyer a socket at `fix` could be matched with, so that one Durable Object
  // stays authoritative over the whole decision. Matching inside it is by
  // distance (`MATCH_RADIUS_METERS`).
  const cell = geohash(
    fix.lat,
    fix.lng,
    intVar(c.env.POOL_CELL_PRECISION, DEFAULT_POOL_CELL_PRECISION),
  )
  const stub = c.env.NUGG_POOL.get(c.env.NUGG_POOL.idFromName(cell))

  // `set` replaces any same-named parameter the caller supplied, so these all
  // reach the Durable Object with server-derived values only.
  const url = new URL(c.req.url)
  /**
   * Identity is the session when there is one, and the browser's demo cookie
   * otherwise. A demo caller may propose a display name but never a user id.
   *
   * This used to mint a fresh `demo:<uuid>` per upgrade, and the comment here
   * said that was what kept two tabs from claiming one identity. It was, and
   * that is no longer what this code does (#101). The pickup QR now carries a
   * link; a phone's own camera app opens it in a **new tab**, which is a new
   * socket — so a per-socket identity arrives at the handoff as a stranger the
   * match has never heard of, on precisely the path the whole feature is for.
   * Reading the id off a cookie is what makes the scanner the same person, which
   * is what lets `worker/pool.ts` recognise them as the receiver of that match.
   *
   * The cost was taken deliberately, not discovered: two tabs in one browser are
   * now one buyer, so the self-match guard refuses to pair them and a
   * single-laptop demo no longer works — pairing needs two devices. That guard
   * has not been weakened, it is simply reached in ordinary use now, which is
   * why `handleJoin` names the tab you are already in rather than failing
   * generically.
   *
   * A caller with no demo cookie still pairs, under a throwaway minted here and
   * nowhere stored. They are the old behaviour: fine for two devices that each
   * fetched `/api/health`, and *not* sticky for a raw socket client that never
   * did. That path degrades to the manual one — the handoff link still shows
   * them six characters to read and type — rather than to a dead end.
   */
  const demoToken = demoTokenFromCookieHeader(c.req.header('Cookie'))
  const identity =
    active !== null
      ? { userId: active.session.userId, displayName: active.session.displayName }
      : {
          userId: demoUserId(demoToken ?? crypto.randomUUID()),
          displayName: sanitizeDemoName(c.req.query('name')),
        }

  url.searchParams.set('cell', cell)
  url.searchParams.set('lat', String(fix.lat))
  url.searchParams.set('lng', String(fix.lng))
  url.searchParams.set('locationSource', fix.source)
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

/**
 * Stripe's view of whether the money moved.
 *
 * Payment results cannot come back over the buyer's socket — a client that says
 * "I paid" is a client that says whatever it likes — so they arrive here, signed.
 * This route is stateless, but the match lives in exactly one NuggPool instance,
 * so the event is routed by the `cell` the PaymentIntent was tagged with at
 * creation. Registered ahead of the /api/* catch-all, which would otherwise 404
 * it.
 */
app.post('/api/stripe/webhook', async (c) => {
  if (!stripeConfigured(c.env)) return c.json({ error: 'payments are not configured' }, 503)

  // Verified against the exact bytes Stripe signed, so this must not be
  // re-serialised from a parsed body.
  const raw = await c.req.text()
  const verified = await verifyStripeSignature(
    raw,
    c.req.header('Stripe-Signature') ?? null,
    c.env.STRIPE_WEBHOOK_SECRET,
  )
  if (!verified.ok) return c.json({ error: verified.reason }, 400)

  const event = parsePaymentEvent(verified.payload)
  // An event type this app does not act on is still a delivery Stripe should stop
  // retrying.
  if (event === null) return c.json({ ok: true, handled: false })

  const { match_id: matchId, role, cell } = event.metadata
  if (
    typeof matchId !== 'string' ||
    matchId.length === 0 ||
    typeof cell !== 'string' ||
    cell.length === 0 ||
    (role !== 'orderer' && role !== 'receiver')
  ) {
    return c.json({ ok: true, handled: false, reason: 'missing routing metadata' })
  }

  const outcome: PaymentOutcomeRequest = {
    matchId,
    role,
    paymentIntentId: event.paymentIntentId,
    outcome: event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed',
  }

  const stub = c.env.NUGG_POOL.get(c.env.NUGG_POOL.idFromName(cell))
  const response = await stub.fetch(
    new Request(`https://nugg-pool.internal${INTERNAL_PAYMENT_PATH}`, {
      method: 'POST',
      body: JSON.stringify(outcome),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  if (!response.ok) return c.json({ error: 'pool rejected the payment event' }, 500)
  return c.json({ ok: true, handled: true })
})

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

export default app

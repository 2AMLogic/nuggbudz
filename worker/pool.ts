import { DurableObject } from 'cloudflare:workers'
import { CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS, reviewChatText } from '../shared/chat'
import { findDeal, isDealOffered } from '../shared/deals'
import {
  type DisputeReason,
  parseDisputeReason,
  parseDisputeRefundRequest,
  refundedRoles,
} from '../shared/disputes'
import type { BuyerRole, Settlement } from '../shared/economics'
import { settle } from '../shared/economics'
import {
  DEFAULT_EXPIRY_WINDOWS,
  type ExpiryWindows,
  nextAlarmAt,
  type OpenMatch,
  planSweep,
  type QueueEntry,
  queueDeadline,
  resolveWindows,
} from '../shared/expiry'
import { DEFAULT_MATCH_RADIUS_METERS, distanceMeters, type LatLng, snapToGrid } from '../shared/geo'
import { type HoldReason, parseHoldReason, parseHoldRetryRequest } from '../shared/holds'
import { type LocationSource, parseCoords, parseLocationSource } from '../shared/location'
import { type Candidate, findMatch } from '../shared/matchmaker'
import {
  bothConfirmed,
  confirmedRole,
  DEFAULT_PICKUP_TIMEOUT_MS,
  disputeDeadline,
  generatePickupCode,
  isPickupDisputed,
  noConfirmations,
  type PickupConfirmations,
  pendingRole,
} from '../shared/pickup'
import {
  type JoinMessage,
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol'
import { slidingWindow } from '../shared/ratelimit'
import { STANDING_TIEBREAK_WINDOW_MS, type StandingBand } from '../shared/reputation'
import { parseSauceSelection, type SauceSelection } from '../shared/sauces'
import { boolVar, type Env, intVar, stripeConfigured } from './env'
import { type HeldMatch, writeDisputedMatch, writeHeldMatch, writeSettledMatch } from './ledger'
import {
  allLegsPaid,
  applyPaymentOutcome,
  centsFor,
  codeAtMatchTime,
  collectedCents,
  holdsCollectedMoney,
  markRefunded,
  openLedger,
  type PaymentDisposition,
  type PaymentLedger,
  type PaymentLeg,
  type PaymentOutcomeRequest,
  type PaymentTombstone,
  parsePaymentOutcome,
  paymentDisposition,
  paymentIntentSpecs,
  refundableLegs,
  refundIdempotencyKey,
  retireLedger,
} from './lib/payments'
import { createPaymentIntent, refundPaymentIntent, type StripeClientConfig } from './lib/stripe'
import { type ReputationUpdate, readStandings, recordReputation } from './reputation'

/**
 * Where the Worker forwards a signature-verified Stripe event. Not a route a
 * browser can reach: the only way in is a Durable Object stub.
 */
export const INTERNAL_PAYMENT_PATH = '/__internal/payment'

/**
 * Where the Worker asks this cell to act on an operator's dispute resolution.
 *
 * Same shape as the payment path above, and for the same reason: a resolution
 * that refunds has to reach the money, and the money lives in whichever instance
 * owned the match. Not a route a browser can reach — the only way in is a
 * Durable Object stub, and the only caller is behind the operator allowlist.
 */
export const INTERNAL_DISPUTE_PATH = '/__internal/dispute'

/**
 * Where the Worker asks this cell to try a refused refund again.
 *
 * The non-dispute counterpart of the path above. A hold is not a decision, so
 * this carries no resolution and takes no argument but the match: every refund
 * is keyed on `refundIdempotencyKey`, which is exactly what makes re-asking
 * safe any number of times. Not a route a browser can reach, and the only
 * caller is behind the operator allowlist.
 */
export const INTERNAL_HOLD_PATH = '/__internal/hold'

/**
 * Where a retired match's unfinished money lives.
 *
 * A separate keyspace from `match:` on purpose: `matchRecords()` lists that
 * prefix and feeds the expiry sweep, `handleConfirmPickup` and `scheduleSweep`,
 * and a tombstone must not be visible to any of them. It is money, not a match.
 */
const TOMBSTONE_PREFIX = 'paytomb:'

/**
 * A holds row D1 would not take yet, parked until it will.
 *
 * The same discipline `persistTerminal` follows for a settled or disputed
 * match, in the one place that discipline could not simply be reused: a hold is
 * filed for a match whose status is still `pending`, and `reconcileTerminal`
 * deliberately skips those. So the row itself is kept rather than the record,
 * and `reconcileHolds` replays it off the next alarm. Its own keyspace for the
 * same reason the tombstone has one — nothing that lists matches may see it.
 */
const PENDING_HOLD_PREFIX = 'holdfile:'

/**
 * How long a tombstone that holds no money is kept.
 *
 * Only ever reached by a tombstone whose legs are all still `pending`: Stripe
 * gives up retrying a webhook after about three days, so after four nothing will
 * ever land against it and there is nothing to wait for. A tombstone that still
 * has collected cents in it is *never* collected here — that one is the
 * reconciliation record for money this pool failed to give back.
 */
const TOMBSTONE_RETENTION_MS = 4 * 24 * 60 * 60 * 1_000

/**
 * Who is on the other end of a socket.
 *
 * Identity and cell are both set by the Worker at upgrade time and never from a
 * client message, so a connection cannot rename itself or move shard.
 */
interface Principal {
  connId: string
  userId: string
  name: string
  cell: string
  /**
   * The location the Worker resolved for this socket, and the rung it came from.
   * A join with no coordinates of its own — the promptless default — is placed
   * here, which is also the coordinate the cell was derived from.
   */
  origin: LatLng
  locationSource: LocationSource
}

interface BuyerIdentity extends Principal {
  dealId: string
  lat: number
  lng: number
  joinedAt: number
  /**
   * The two sauces this buyer asked for, validated against the catalogue before
   * it was ever put here, or null if they picked none. Shown to their buddy,
   * because one of the two is about to stand at a counter and order.
   */
  sauces: SauceSelection | null
}

type ConnState =
  | ({ status: 'idle' } & Principal)
  | ({
      status: 'waiting'
      /** Last sign of life from this buyer: the join, or their latest ping. */
      lastSeenAt: number
      /** Whether they have been told they are about to be dropped. */
      warned: boolean
    } & BuyerIdentity)
  | ({
      status: 'matched'
      matchId: string
      role: BuyerRole
      /**
       * Timestamps of this connection's recent chat attempts, for the sliding
       * window in `shared/ratelimit.ts`.
       *
       * In the hibernation attachment rather than an instance field, like every
       * other piece of per-connection state, so an evicted cell does not forget
       * that somebody was mid-flood. Optional because a socket attached before
       * this field existed has to deserialize rather than break. It is *not*
       * conversation: only the times messages were attempted, and it dies with
       * the match when the socket drops back to `principalOf`.
       */
      chatHits?: number[]
    } & BuyerIdentity)

type WaitingState = Extract<ConnState, { status: 'waiting' }>
type MatchedState = Extract<ConnState, { status: 'matched' }>

/** One buyer as the match record remembers them, independent of their socket. */
interface MatchBuyer {
  connId: string
  userId: string
  name: string
}

interface MatchRecord {
  matchId: string
  dealId: string
  cell: string
  createdAt: number
  distanceMeters: number
  orderer: MatchBuyer
  receiver: MatchBuyer
  /**
   * Random, and deliberately not derived from `matchId`: the match id is sent to
   * both buddies, so a derived code would prove nothing about having met.
   */
  pickupCode: string
  confirmations: PickupConfirmations
  /** `pending` until both sides confirm, or until one side runs out of time. */
  status: 'pending' | 'complete' | 'disputed'
  /** The split as computed at match time; the ledger writes exactly this. */
  settlement: Settlement
  settledAt: number | null
  disputedAt: number | null
  /**
   * Why this match was disputed, kept on the record rather than only on the
   * outgoing message.
   *
   * The D1 write is the point: a record whose write failed is retried later by
   * `reconcileTerminal`, from the record alone, and a reason that lived only in
   * the call frame that produced it would be lost by then. Optional because a
   * record written before this field existed has none.
   */
  disputedReason?: DisputeReason | null
  /**
   * How this match is paid for, decided once and written before either buddy is
   * told they are matched. Persisted rather than recomputed so the answer cannot
   * change underneath a live match when a secret is rotated — and so the window
   * between `matched` and the first PaymentIntent is not a window in which the
   * pickup gate is open.
   */
  disposition: PaymentDisposition
  /** The charges, once opened. Absent for every disposition but `charge`. */
  ledger?: PaymentLedger
}

/**
 * Why a match is being retired, stated by the path that is retiring it.
 *
 * A required argument to `retireMatch` rather than something derived from the
 * record, because it genuinely cannot be derived: four different teardowns
 * leave a record in exactly the same `pending` state, and which one it was is
 * the only thing that tells an operator what happened to the two people whose
 * money is stuck. Making it required is the point — a fifth teardown path
 * cannot compile without saying which of these it is.
 *
 * `settled` and `disputed` are here so those two paths *name* themselves rather
 * than opting out by omission, and they file no hold: a settled split owes
 * nothing back, and a dispute's money is already recorded in `disputes`.
 */
type TeardownReason = HoldReason | 'settled' | 'disputed'

/** What a terminal record's own status says its teardown was. */
function terminalReason(record: MatchRecord): TeardownReason {
  return record.status === 'complete' ? 'settled' : 'disputed'
}

/**
 * The holds row a retired match and its tombstone come to, between them.
 *
 * The buyers and the deal come off the match record, which is about to be
 * deleted and is the last place they exist; the money comes off the tombstone's
 * ledger, which is the only thing that knows what Stripe actually kept.
 */
function heldMatchFrom(
  record: MatchRecord,
  tombstone: PaymentTombstone,
  reason: HoldReason,
): HeldMatch {
  return {
    matchId: record.matchId,
    dealId: record.dealId,
    cell: record.cell,
    createdAt: record.createdAt,
    retiredAt: tombstone.retiredAt,
    reason,
    heldCents: collectedCents(tombstone.ledger),
    names: { orderer: record.orderer.name, receiver: record.receiver.name },
    userIds: { orderer: record.orderer.userId, receiver: record.receiver.userId },
  }
}

/**
 * Is this match's pickup code released yet?
 *
 * The one question that gates both the code itself and `confirm_pickup`, and
 * therefore the only route to a D1 ledger row. A `charge` match answers false
 * until the ledger says both halves actually succeeded, so neither a half-paid
 * nor an unpaid match can reach a code or a settled row.
 *
 * A record from before this field existed has no disposition, which answers
 * false — the fail-closed direction.
 */
function pickupUnlocked(record: MatchRecord): boolean {
  if (codeAtMatchTime(record.disposition)) return true
  return record.ledger !== undefined && allLegsPaid(record.ledger)
}

/**
 * The matching market for one geohash cell.
 *
 * Every buyer in a neighbourhood is routed to the same instance of this object,
 * and Durable Objects process one event at a time. That single-threadedness is
 * the whole reason this design is safe: two buyers physically cannot be paired
 * to the same third party, and no lock, transaction or compare-and-swap is
 * needed to guarantee it.
 *
 * Per-connection state lives in the socket's hibernation attachment rather than
 * in an instance field, so an idle cell can be evicted from memory between the
 * lunch and dinner rushes without losing the queue.
 */
export class NuggPool extends DurableObject<Env> {
  /**
   * The market: how far apart two buyers may be and still be paired.
   *
   * This — not the shard — is the product rule, so it is also what scopes every
   * count and roster this object broadcasts. Read fresh from the var so a
   * repriced radius takes effect without a redeploy of the client.
   */
  private get radiusMeters(): number {
    return intVar(this.env.MATCH_RADIUS_METERS, DEFAULT_MATCH_RADIUS_METERS)
  }

  private get pickupTimeoutMs(): number {
    return intVar(this.env.PICKUP_CONFIRM_TIMEOUT_MS, DEFAULT_PICKUP_TIMEOUT_MS)
  }

  /** How far behind the longest waiter standing is still allowed to decide. */
  private get standingTiebreakMs(): number {
    const fallbackSeconds = Math.round(STANDING_TIEBREAK_WINDOW_MS / 1_000)
    return intVar(this.env.STANDING_TIEBREAK_SECONDS, fallbackSeconds) * 1_000
  }

  /** Liveness policy for this cell, read fresh so a var change takes effect. */
  private get windows(): ExpiryWindows {
    const ms = (raw: string | undefined, fallbackMs: number) =>
      intVar(raw, Math.round(fallbackMs / 1_000)) * 1_000
    return resolveWindows({
      queueIdleMs: ms(this.env.QUEUE_IDLE_SECONDS, DEFAULT_EXPIRY_WINDOWS.queueIdleMs),
      queueWarnLeadMs: ms(this.env.QUEUE_WARN_LEAD_SECONDS, DEFAULT_EXPIRY_WINDOWS.queueWarnLeadMs),
      matchTimeoutMs: ms(this.env.MATCH_CONFIRM_SECONDS, DEFAULT_EXPIRY_WINDOWS.matchTimeoutMs),
    })
  }

  /**
   * The Stripe client for this cell, or null when payments are not configured.
   *
   * Read fresh each time rather than cached in a field: a Durable Object can live
   * across a secret rotation, and a stale null here would be a cell that quietly
   * stopped taking money.
   */
  private get stripe(): StripeClientConfig | null {
    if (!stripeConfigured(this.env)) return null
    const apiBase = this.env.STRIPE_API_BASE
    return {
      secretKey: this.env.STRIPE_SECRET_KEY,
      ...(apiBase !== undefined && apiBase.length > 0 ? { apiBase } : {}),
    }
  }

  /**
   * How a pair would be paid for. Called with the real pair at match time, and
   * with one buyer standing in for both at join time — a buyer nobody could
   * charge should be told so before they wait in a queue for nothing.
   *
   * The single decision both the Stripe call and the pickup-code release read.
   */
  private dispositionFor(userIds: Record<BuyerRole, string>): PaymentDisposition {
    return paymentDisposition({
      stripeConfigured: stripeConfigured(this.env),
      unchargedAllowed: boolVar(this.env.ALLOW_UNCHARGED_PAIRING),
      userIds,
    })
  }

  override async fetch(request: Request): Promise<Response> {
    // Four ways in: a buyer's socket, a signature-verified Stripe event the
    // Worker forwarded here because this instance owns the match, an operator's
    // resolution of a dispute this instance is still holding money for, and an
    // operator retrying a refund this instance could not make.
    const path = new URL(request.url).pathname
    if (path === INTERNAL_PAYMENT_PATH) return await this.handlePaymentEvent(request)
    if (path === INTERNAL_DISPUTE_PATH) return await this.handleDisputeResolution(request)
    if (path === INTERNAL_HOLD_PATH) return await this.handleHoldRetry(request)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }

    const params = new URL(request.url).searchParams
    // The Worker authenticates the upgrade and passes the session's identity
    // down. Missing identity means the request did not come through that path,
    // so refuse rather than seat an anonymous buyer.
    const userId = params.get('userId') ?? ''
    const name = params.get('displayName') ?? ''
    if (userId.length === 0 || name.length === 0) {
      return new Response('unauthenticated', { status: 401 })
    }

    // Same reasoning for the location: the Worker resolves it and passes it down,
    // so its absence means this request did not come through that path. Refusing
    // is better than seating a buyer at a coordinate nobody chose.
    const origin = parseCoords({ lat: params.get('lat'), lng: params.get('lng') })
    const locationSource = parseLocationSource(params.get('locationSource'))
    if (origin === null || locationSource === null) {
      return new Response('missing server-derived location', { status: 400 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)

    const connId = crypto.randomUUID()
    const cell = params.get('cell') ?? ''
    this.setState(server, {
      status: 'idle',
      connId,
      userId,
      name,
      cell,
      origin,
      locationSource,
    })

    this.send(server, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      cell,
      // Their own position, and the rung that produced it, so the map has a
      // centre on every rung rather than only when a permission prompt was
      // answered. The radius travels with it: the client draws the circle the
      // server is actually matching in, and hardcodes nothing.
      position: origin,
      locationSource,
      radiusMeters: this.radiusMeters,
      // Scoped to the radius, not the shard, for the same reason `sendWaiting`
      // is: at this precision the shard is a region, and "42 waiting" two
      // counties away is not a fact about anybody's night.
      waiting: this.withinRadius(origin).length,
      user: { id: userId, name },
      expiry: this.windows,
      pickupTimeoutMs: this.pickupTimeoutMs,
    })

    await this.adoptLiveHandoff(server, userId, connId)

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Seat a second socket of somebody who is already mid-handoff.
   *
   * This is what the handoff link needs on the server side (#101). A phone's own
   * camera app opens `/h/<code>` in a new tab, the app there opens a socket, and
   * that socket has to be recognised as the same buyer — otherwise the scanner
   * arrives as a stranger and the link is decorative. Identity is what makes
   * that possible: a signed-in buyer's session cookie and a demo buyer's demo
   * cookie both survive a new tab, so "the same person" is a fact the server
   * establishes rather than a claim the client makes.
   *
   * Deliberately narrow in three ways.
   *
   * - **It adopts nothing but a released handoff.** `pickupUnlocked` is the
   *   gate, so a match still being charged is never adopted: the second socket
   *   would need a `payment_required` carrying a client secret that belongs to
   *   one browser session, and handing the same charge to two screens is a worse
   *   answer than showing the code to read. Those callers stay idle, and the app
   *   falls back to printing the six characters.
   * - **It confirms nothing.** All that arrives here is `matched` — the same
   *   message the first tab got. The receiver still taps, and
   *   `handleConfirmPickup` still checks the code against the record and the
   *   role against the socket. An opened link that settled money would be a link
   *   a bystander can photograph across a table and tap from their seat.
   * - **It is found from live sockets, not from storage.** The only match worth
   *   adopting is one whose other side is still connected; a match whose sockets
   *   have all gone has already been torn down by `handleDisconnect`. So this
   *   costs one pass over this cell's sockets and never a storage scan.
   */
  private async adoptLiveHandoff(ws: WebSocket, userId: string, connId: string): Promise<void> {
    const held = this.states().find(
      (other) =>
        other.ws !== ws && other.state.status === 'matched' && other.state.userId === userId,
    )
    if (held === undefined || held.state.status !== 'matched') return

    const { matchId, role } = held.state
    const record = await this.ctx.storage.get<MatchRecord>(`match:${matchId}`)
    if (record === undefined || record.status !== 'pending') return
    if (!pickupUnlocked(record)) return

    // The buddy's own socket, for the name and sauces the receipt prints. Their
    // side of a live match always has one, by the same reasoning as above.
    const buddy = this.matchSockets(matchId).find((peer) => peer.state.role !== role)
    if (buddy === undefined) return

    // This socket's own `connId`, never the one it is copying: if this match is
    // later torn down, both sockets are requeued, and two queue entries sharing
    // an id would be two candidates the matcher cannot tell apart.
    this.setState(ws, { ...identityOf(held.state), connId, status: 'matched', matchId, role })

    const standings = await this.standingsFor([buddy.state.userId])

    this.send(ws, {
      type: 'matched',
      matchId,
      role,
      share: role === 'orderer' ? record.settlement.shares[0] : record.settlement.shares[1],
      settlement: record.settlement,
      buddy: {
        name: buddy.state.name,
        distanceMeters: record.distanceMeters,
        sauces: buddy.state.sauces,
        standing: standings.get(buddy.state.userId) ?? 'new',
      },
      // The same single side, on every socket that side holds. A receiver's
      // second tab gets null here exactly as their first one did — the code
      // still has to travel through the air.
      pickupCode: role === 'orderer' ? record.pickupCode : null,
    })
  }

  override async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    if (typeof raw !== 'string') {
      this.fail(ws, 'bad_message', 'binary frames are not supported')
      return
    }

    const msg = parseClientMessage(raw)
    if (msg === null) {
      this.fail(ws, 'bad_message', 'could not parse message')
      return
    }

    switch (msg.type) {
      case 'ping':
        this.refreshLiveness(ws)
        this.send(ws, { type: 'pong', at: msg.at })
        return
      case 'cancel':
        await this.handleCancel(ws)
        return
      case 'confirm_pickup':
        await this.handleConfirmPickup(ws, msg.code)
        return
      case 'chat':
        await this.handleChat(ws, msg.text)
        return
      case 'join':
        await this.handleJoin(ws, msg)
        return
    }
  }

  /**
   * Relay one line of conversation to the buddy on the other side of a match.
   *
   * **Nothing is stored.** This method reads the match record to decide whether a
   * channel is still open and writes only the sender's rate-limit timestamps back
   * into their own hibernation attachment. No chat text touches
   * `ctx.storage`, D1 or KV, at any point, which is the whole reason the screen
   * can promise a buyer the conversation disappears. A message is handed to a
   * live socket or refused — never buffered for a buddy who might come back.
   *
   * Everything that identifies the speaker comes off the connection: the match,
   * the role and the display name. The frame contributes text and nothing else.
   */
  private async handleChat(ws: WebSocket, raw: string): Promise<void> {
    const state = this.getState(ws)
    if (state === null) return
    if (state.status !== 'matched') {
      this.fail(ws, 'not_matched', 'there is nobody to talk to until you are matched')
      return
    }

    const now = Date.now()
    // Checked before the `ctx.storage.get` below (#79): this is an in-memory
    // read off the connection's own attachment, so a flood costs nothing but
    // the attachment write, where the storage read below costs an actual I/O
    // round trip per refused message. Same sliding window the upgrade limiter
    // uses (#10), per connection rather than per IP, because the thing being
    // limited here is one seat in one match.
    //
    // Consequence, chosen deliberately rather than left as a side effect: a
    // flood against a match that has already finished (settled, disputed, or
    // deleted) now earns `chat_rate_limited` once the window fills, not
    // `not_matched` — the socket-state check above already answers
    // `not_matched` for the common "not matched at all" case, and the storage
    // read a few lines down still answers `not_matched` for the first
    // messages of a burst, before the window closes. Only a *sustained* flood
    // against a dead match changes verdict, and `chat_rate_limited` is no
    // less informative there: it still tells the caller to stop.
    const verdict = slidingWindow(state.chatHits ?? [], now, CHAT_RATE_WINDOW_MS, CHAT_RATE_LIMIT)
    if (!verdict.allowed) {
      this.fail(
        ws,
        'chat_rate_limited',
        `slow down — wait ${verdict.retryAfterSeconds}s before sending again`,
      )
      return
    }
    // Recorded before the text is judged, so a flood of rejected garbage is
    // limited exactly like a flood of valid messages. A rejected *attempt* costs
    // nothing (`slidingWindow` does not record one), so backing off works.
    this.setState(ws, { ...state, chatHits: verdict.hits })

    // The match record is the authority on whether this channel exists. A
    // settled, disputed or deleted match closes it, so a message arriving after
    // `pickup_complete`, after a dispute, or after a buddy walked away is refused
    // here rather than relayed into a conversation that is over. Both this and
    // the socket-state check above have to hold: the socket is dropped back to
    // idle at the same moments, and either alone would be a single point of
    // failure for the one guarantee the feature makes.
    const record = await this.ctx.storage.get<MatchRecord>(`match:${state.matchId}`)
    if (record === undefined || record.status !== 'pending') {
      this.fail(ws, 'not_matched', 'that match is finished, and the chat went with it')
      return
    }

    const reviewed = reviewChatText(raw)
    if (!reviewed.ok) {
      if (reviewed.reason === 'too_long') {
        this.fail(ws, 'chat_too_long', 'that is too long to shout across a counter')
      } else {
        this.fail(ws, 'chat_empty', 'there was nothing readable in that message')
      }
      return
    }

    // Exactly the two sockets in this match, which is what keeps a third buyer in
    // the same cell from hearing any of it. `matchSockets` filters on the
    // connection's own matchId, so a cell hosting several matches at once relays
    // each conversation only within itself.
    const [buddy] = this.matchSockets(state.matchId, ws)
    if (buddy === undefined) {
      this.fail(ws, 'buddy_offline', 'your bud is not connected right now')
      return
    }

    const relay: ServerMessage = {
      type: 'chat_message',
      matchId: state.matchId,
      from: state.role,
      // The authenticated name, like everywhere else.
      name: state.name,
      text: reviewed.text,
      at: now,
    }
    this.send(buddy.ws, relay)
    // Echoed to the sender so both screens show the same sanitized line, rather
    // than the sender reading their own draft and the buddy reading what
    // survived cleaning.
    this.send(ws, relay)
  }

  /**
   * The one alarm this cell gets, shared by the two deadlines a match can be
   * under and by the queue's idle timer.
   *
   * The dispute sweep runs first, and that ordering is load-bearing: a match one
   * side has confirmed must become a dispute, never an expiry cancellation, so
   * it is taken out of contention before the expiry sweep looks at the market.
   *
   * `match:` is listed exactly once here and threaded through to every phase
   * below (#87 — `reconcileTerminal`, `sweepExpired` and `scheduleSweep` used
   * to each list it again themselves, four full scans of a shard's dispute
   * history per tick). A record this loop successfully disputes is deleted
   * from the local map the moment `disputeMatch` retires it, so
   * `reconcileTerminal` — which persists anything not `pending` — never
   * replays a write this tick already made durable.
   */
  override async alarm(): Promise<void> {
    const now = Date.now()
    const records = await this.matchRecords()
    for (const record of [...records.values()]) {
      if (record.status !== 'pending') continue
      if (!isPickupDisputed(record.confirmations, now, this.pickupTimeoutMs)) continue
      if (await this.disputeMatch(record, now, 'timeout')) records.delete(record.matchId)
    }

    await this.reconcileTerminal(records)
    await this.reconcileHolds()
    await this.sweepExpired(now, records)
    await this.scheduleSweep(records)
  }

  /**
   * Retry the durable write for any finished match still sitting in storage.
   *
   * A complete or disputed record is deleted the moment D1 has it, so reaching
   * one here means a write failed — a D1 outage during `completeMatch`, or a
   * dispute raised while the database was unreachable. Nothing else would ever
   * look at it again: the expiry sweep only considers `pending` matches, and
   * that is exactly how terminal records used to accumulate in a cell forever.
   *
   * Opportunistic rather than scheduled, deliberately. A cell with nothing but a
   * stuck record arms no alarm and needs none — nobody is waiting on it — and
   * the next buyer through that shard arms one within the queue's idle window.
   * An alarm armed for the retry itself would keep waking a cell on a permanent
   * failure (an identity D1 will refuse forever) with nothing new to try.
   *
   * `records` is this tick's one `match:` read (see `alarm`), not a fresh list —
   * mutated in place as entries are retired, so the caller's later phases see
   * the same retirements.
   */
  private async reconcileTerminal(records: Map<string, MatchRecord>): Promise<void> {
    for (const record of [...records.values()]) {
      if (record.status === 'pending') continue
      if (await this.persistTerminal(record)) {
        await this.retireMatch(record.matchId, record, terminalReason(record))
        records.delete(record.matchId)
      }
    }
  }

  /**
   * Put a finished match where it outlives this object, and say whether it
   * landed.
   *
   * The one answer both terminal paths need, because the rule they share is the
   * rule that matters: a record is deleted from Durable Object storage **only**
   * after D1 has it. A false here keeps the record, which is what a
   * reconciliation replays from.
   *
   * A demo pairing writes nothing and answers true. That is not a failure being
   * swallowed — a demo handshake is neither revenue nor a dispute a human owes
   * anybody an answer about, so there is nothing to keep the record for.
   */
  private async persistTerminal(record: MatchRecord): Promise<boolean> {
    try {
      if (record.status === 'complete') {
        await writeSettledMatch(this.env.DB, {
          matchId: record.matchId,
          dealId: record.dealId,
          cell: record.cell,
          distanceMeters: record.distanceMeters,
          createdAt: record.createdAt,
          settledAt: record.settledAt ?? Date.now(),
          settlement: record.settlement,
          names: { orderer: record.orderer.name, receiver: record.receiver.name },
          // The ledger decides for itself whether this is a real split; a demo
          // pairing settles on screen and books nothing. See `isDemoMatch`.
          userIds: { orderer: record.orderer.userId, receiver: record.receiver.userId },
        })
        return true
      }
      if (record.status === 'disputed') {
        // Parsed rather than cast: a record written before the reason was
        // persisted has none, and the column will not accept a guess.
        const reason = parseDisputeReason(record.disputedReason)
        if (reason === null) {
          console.error('NuggPool: dispute %s has no recorded reason — not filing', record.matchId)
          return false
        }
        const confirmedBy = confirmedRole(record.confirmations)
        await writeDisputedMatch(this.env.DB, {
          matchId: record.matchId,
          dealId: record.dealId,
          cell: record.cell,
          createdAt: record.createdAt,
          disputedAt: record.disputedAt ?? Date.now(),
          reason,
          confirmedBy,
          confirmedAt: confirmedBy === null ? null : record.confirmations[confirmedBy],
          // What Stripe is holding right now, off the payment ledger rather
          // than recomputed from the settlement: a half-refunded match holds
          // less than it collected, and the operator is being asked about the
          // money that is actually there.
          heldCents: record.ledger === undefined ? 0 : collectedCents(record.ledger),
          names: { orderer: record.orderer.name, receiver: record.receiver.name },
          userIds: { orderer: record.orderer.userId, receiver: record.receiver.userId },
        })
        return true
      }
    } catch (error) {
      // Never rethrown. A D1 outage must not strand two people who already
      // swapped nuggets, and must not swallow the evidence either: the record
      // stays in storage and `reconcileTerminal` tries again.
      console.error('durable write failed', record.status, record.matchId, error)
    }
    return false
  }

  /**
   * Age out whatever has gone stale in this cell: buyers who stopped answering,
   * and matches neither side ever confirmed.
   *
   * One sweep per cell rather than a timer per connection — a Durable Object
   * processes one event at a time, so a single sweep sees the whole market and
   * two timers can never disagree about who is still queued.
   *
   * `records` is `alarm`'s one `match:` read, not a fresh list (#87).
   */
  private async sweepExpired(now: number, records: Map<string, MatchRecord>): Promise<void> {
    const windows = this.windows
    const queue = this.waitingStates()
    const plan = planSweep(
      now,
      queue.map(({ state }) => livenessOf(state)),
      expirableMatches(records.values()),
      windows,
    )

    for (const connId of plan.warn) {
      const entry = queue.find((q) => q.state.connId === connId)
      if (entry === undefined) continue
      this.setState(entry.ws, { ...entry.state, warned: true })
      this.send(entry.ws, {
        type: 'queue_expiring',
        expiresAt: queueDeadline(livenessOf(entry.state), windows),
      })
    }

    for (const connId of plan.expire) {
      const entry = queue.find((q) => q.state.connId === connId)
      if (entry === undefined) continue
      this.setState(entry.ws, principalOf(entry.state))
      // Dropped, and told why: a silent removal looks like the pool losing them.
      this.send(entry.ws, { type: 'queue_expired', reason: 'idle', idleMs: windows.queueIdleMs })
    }

    for (const matchId of plan.cancel) {
      await this.cancelMatch(matchId)
      // `cancelMatch` deletes the storage record itself; drop it from this
      // tick's cached map too, so `scheduleSweep` below doesn't compute a
      // wake-up time off a match that is already gone.
      records.delete(matchId)
    }

    await this.sweepTombstones(now)

    // Anyone dropped has left everyone else's roster, so the map dots and pool
    // counts still showing them have to be refreshed.
    if (plan.expire.length > 0 || plan.cancel.length > 0) this.broadcastWaiting()
  }

  /**
   * Call off a match neither side ever confirmed.
   *
   * Both halves go back to idle rather than the queue: at least one of them has
   * walked away, and requeueing two still-connected buyers would just pair them
   * with each other again on the spot. The record is deleted, unlike a dispute —
   * nobody claimed anything, so there is nothing for a human to look at.
   */
  private async cancelMatch(matchId: string): Promise<void> {
    // Read before the delete below, and before the sockets are dropped back to
    // idle: the match record is the only thing that still knows who these two
    // were.
    const record = await this.ctx.storage.get<MatchRecord>(`match:${matchId}`)
    // Whatever was collected for a box nobody turned up for goes back. This is
    // the field `match_expired.refundedCents` was reserved for: a cancellation
    // can never be reported without saying what happened to the money — and
    // `refundedCents` counts refunds Stripe *confirmed*, never refunds attempted.
    let retired = record
    let refunded: PaymentLeg[] = []
    let held: PaymentLeg[] = []
    if (record?.ledger !== undefined) {
      const settled = await this.settleRefunds(matchId, record.ledger)
      retired = { ...record, ledger: settled.ledger }
      refunded = settled.refunded
      held = settled.held
      await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, retired)
    }
    // Only the orderer is charged with the cancellation, and the asymmetry is
    // deliberate. The orderer can confirm a handoff on their own — they hold the
    // code and only have to tap — so an orderer who was standing there with the
    // box would have confirmed, and their silence is evidence. The receiver has
    // to read the code off them, so a receiver who turned up to nobody *cannot*
    // confirm; counting that against them would punish them for the other
    // buddy's no-show.
    if (record !== undefined) {
      await this.recordStanding([{ userId: record.orderer.userId, event: 'late_cancel' }])
    }

    for (const peer of this.matchSockets(matchId)) {
      this.setState(peer.ws, principalOf(peer.state))
      this.send(peer.ws, {
        type: 'match_expired',
        matchId,
        reason: 'unconfirmed',
        refundedCents: centsFor(refunded, peer.state.role),
        heldCents: centsFor(held, peer.state.role),
      })
    }
    await this.retireMatch(matchId, retired, 'match_expired')
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws)
  }

  private async handleJoin(ws: WebSocket, msg: JoinMessage): Promise<void> {
    const dealId = msg.dealId
    const state = this.getState(ws)
    if (state === null) return
    if (state.status === 'waiting') {
      this.fail(ws, 'already_waiting', 'this connection is already queued')
      return
    }
    if (state.status === 'matched') {
      this.fail(ws, 'already_matched', 'this connection is already matched')
      return
    }

    /**
     * A second tab is not a second buyer, and since #101 it is an ordinary thing
     * to be.
     *
     * Identity used to be minted per socket, so two tabs were two people and
     * this only ever fired for two tabs of one signed-in account — an edge case
     * that could be left to the candidate filter below, which silently left the
     * second tab queued forever. Demo identity is per browser now, so anybody
     * who opens the app twice lands here. Silence would read as a queue that
     * never matches; say which tab they are already in instead.
     */
    const elsewhere = this.states().find(
      (other) =>
        other.ws !== ws &&
        other.state.userId === state.userId &&
        (other.state.status === 'waiting' || other.state.status === 'matched'),
    )
    if (elsewhere !== undefined) {
      if (elsewhere.state.status === 'matched') {
        this.fail(
          ws,
          'already_matched',
          'you are already in a match in another tab or window — finish it there',
        )
      } else {
        this.fail(
          ws,
          'already_waiting',
          'you are already waiting in another tab or window — two tabs are one buyer, so this one cannot queue beside it',
        )
      }
      return
    }

    // This id came off a socket, so the question is "may this be chosen", not
    // "does this exist" — a gated deal still resolves in the catalogue, and
    // `findDeal` alone would let a hand-rolled `join` frame pair and settle on a
    // chain the app does not offer. `unknown_deal` rather than a distinct code
    // on purpose: which chains are gated is not a caller's to enumerate.
    const deal = findDeal(dealId)
    if (deal === undefined || !isDealOffered(deal.id)) {
      this.fail(ws, 'unknown_deal', `no such deal: ${dealId}`)
      return
    }

    // Fail closed, and fail early. A pool with no Stripe secrets bound — and no
    // operator saying that was deliberate — cannot charge anybody, so it must not
    // seat a buyer who would be paired and then told there is no way to pay. The
    // same decision runs again with the real pair below; this one asks it of a
    // buyer standing alone, which is what a queue seat is a promise about.
    if (this.dispositionFor({ orderer: state.userId, receiver: state.userId }) === 'refuse') {
      console.error('NuggPool: refusing to queue %s — payments are not configured', state.cell)
      this.fail(ws, 'payment_unavailable', 'this pool cannot take payments right now')
      return
    }

    // Coordinates in the join message are the opt-in precise path; without them
    // the socket's server-resolved origin stands. Either only ever moves a buyer
    // within the market they were already routed to — the cell was decided at
    // upgrade time and is not re-derived here. `parseCoords` re-validates both,
    // and covers a socket whose attachment predates this field.
    const fix = parseCoords(msg) ?? parseCoords(state.origin)
    if (fix === null) {
      this.fail(ws, 'bad_message', 'this connection has no location; reconnect')
      return
    }

    // These ids came off a socket too, so they are checked against the catalogue
    // rather than stored as sent — and against *this deal's* menu, because a
    // Wendy's sauce with a McDonald's box is not an order anyone can place. The
    // refusal deliberately does not repeat the id back: an unvalidated string is
    // not something to echo, and which ids exist is not a caller's to enumerate.
    const sauces = msg.sauces === undefined ? null : parseSauceSelection(msg.sauces, deal.merchant)
    if (msg.sauces !== undefined && sauces === null) {
      this.fail(ws, 'unknown_sauce', 'those are not two sauces on this menu')
      return
    }

    const identity: BuyerIdentity = {
      connId: state.connId,
      // The authenticated name, not anything the client sent.
      userId: state.userId,
      name: state.name,
      cell: state.cell,
      origin: state.origin,
      locationSource: state.locationSource,
      dealId,
      lat: fix.lat,
      lng: fix.lng,
      joinedAt: Date.now(),
      sauces,
    }
    // Belt and braces on the refusal above: whatever route a socket took to get
    // here, an identity is never a candidate for itself.
    const others = this.waitingStates().filter((o) => o.state.userId !== identity.userId)
    // Read fresh, for the joiner and everyone they might pair with, rather than
    // cached in the queue entry: a buyer who completed a split two minutes ago
    // should be matched on the standing they have now, and a hibernation
    // attachment written before that would say otherwise. One query, not one per
    // waiting buyer — see `readStandings`.
    const standings = await this.standingsFor([
      identity.userId,
      ...others.map((o) => o.state.userId),
    ])
    const decision = findMatch(
      toCandidate(identity, standings),
      others.map((o) => toCandidate(o.state, standings)),
      this.radiusMeters,
      this.standingTiebreakMs,
    )

    if (decision === null) {
      await this.enqueue(ws, identity)
      return
    }

    // The buddy is whichever of the pair is not this connection.
    const buddyConnId =
      decision.orderer.id === identity.connId ? decision.receiver.id : decision.orderer.id
    const buddy = others.find((o) => o.state.connId === buddyConnId)
    if (buddy === undefined) {
      // Buddy vanished between the scan and here. Queue instead of pairing with a ghost.
      await this.enqueue(ws, identity)
      return
    }

    const matchId = crypto.randomUUID()
    const settlement = settle(deal, 2)
    const ordererIsSelf = decision.orderer.id === identity.connId
    const selfIdentity = identity
    const buddyIdentity = identityOf(buddy.state)

    const selfRole: BuyerRole = ordererIsSelf ? 'orderer' : 'receiver'
    const buddyRole: BuyerRole = ordererIsSelf ? 'receiver' : 'orderer'
    const ordererIdentity = ordererIsSelf ? selfIdentity : buddyIdentity
    const receiverIdentity = ordererIsSelf ? buddyIdentity : selfIdentity

    const pickupCode = generatePickupCode()
    // Decided from the real pair, and written with the record — before either
    // buddy is told they are matched, so there is no instant at which a
    // chargeable match has an unlocked pickup gate.
    const disposition = this.dispositionFor({
      orderer: ordererIdentity.userId,
      receiver: receiverIdentity.userId,
    })
    await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, {
      matchId,
      dealId,
      cell: identity.cell,
      createdAt: Date.now(),
      distanceMeters: decision.distanceMeters,
      orderer: buyerOf(ordererIdentity),
      receiver: buyerOf(receiverIdentity),
      pickupCode,
      confirmations: noConfirmations(),
      status: 'pending',
      settlement,
      settledAt: null,
      disputedAt: null,
      disposition,
    })

    const shareFor = (role: BuyerRole) =>
      role === 'orderer' ? settlement.shares[0] : settlement.shares[1]
    // Only the orderer is told the code. The receiver has to go and read it off
    // them, which is the entire proof that the two of them met — and not even the
    // orderer gets it yet when the match is being charged, because a code handed
    // out before both cards clear buys a box nobody paid for. `payment_cleared`
    // delivers it then, to the same single side.
    const codeReleased = codeAtMatchTime(disposition)
    const codeFor = (role: BuyerRole) => (role === 'orderer' && codeReleased ? pickupCode : null)

    this.setState(ws, { ...selfIdentity, status: 'matched', matchId, role: selfRole })
    this.setState(buddy.ws, { ...buddyIdentity, status: 'matched', matchId, role: buddyRole })

    this.send(ws, {
      type: 'matched',
      matchId,
      role: selfRole,
      share: shareFor(selfRole),
      settlement,
      buddy: {
        name: buddyIdentity.name,
        distanceMeters: decision.distanceMeters,
        sauces: buddyIdentity.sauces,
        // The band each buddy is told about the other, off the same read the
        // pairing decision used, so the screen and the rule cannot disagree.
        standing: standings.get(buddyIdentity.userId) ?? 'new',
      },
      pickupCode: codeFor(selfRole),
    })
    this.send(buddy.ws, {
      type: 'matched',
      matchId,
      role: buddyRole,
      share: shareFor(buddyRole),
      settlement,
      buddy: {
        name: selfIdentity.name,
        distanceMeters: decision.distanceMeters,
        sauces: selfIdentity.sauces,
        standing: standings.get(selfIdentity.userId) ?? 'new',
      },
      pickupCode: codeFor(buddyRole),
    })

    // Two buyers just left the waiting pool: everyone still queued in this
    // cell needs the roster refreshed, or their map would keep showing dots
    // for buddies who are no longer waiting.
    this.broadcastWaiting()
    // The match now has a confirmation deadline of its own.
    await this.scheduleSweep()

    // Last, so a processor that will not open the charges tears down a match
    // that was otherwise fully consistent.
    await this.startPayments(matchId, disposition, deal.label, settlement)
  }

  /**
   * Put both halves of a fresh match up for payment.
   *
   * Amounts come out of the settlement untouched — see `paymentIntentSpecs` — and
   * each intent is keyed on `${matchId}:${role}`, so a retry resolves to the
   * charge that already exists rather than a second one.
   *
   * Nothing but a `charge` disposition reaches Stripe. That is enforced here, on
   * the one path that talks to the processor, rather than by a predicate a future
   * caller has to remember to ask: a demo pair returns before `this.stripe` is
   * even read.
   */
  private async startPayments(
    matchId: string,
    disposition: PaymentDisposition,
    dealLabel: string,
    settlement: Settlement,
  ): Promise<void> {
    if (disposition === 'demo' || disposition === 'uncharged') return
    const stripe = disposition === 'charge' ? this.stripe : null
    if (stripe === null) {
      // Either `refuse`, or a secret that vanished between the join check and
      // here. Both mean the same thing: there is no way to charge for this box,
      // so there is no box. The one thing this must never do is release a code.
      console.error('NuggPool: cannot charge match %s — aborting rather than clearing', matchId)
      await this.abortMatch(matchId, 'this pool cannot take payments right now')
      return
    }

    const record = await this.ctx.storage.get<MatchRecord>(`match:${matchId}`)
    if (record === undefined) return

    const specs = paymentIntentSpecs(settlement, {
      matchId,
      cell: record.cell,
      description: `NuggBudz split — ${dealLabel}`,
    })

    const created: { id: string; clientSecret: string }[] = []
    try {
      for (const spec of specs) {
        created.push(
          await createPaymentIntent(stripe, {
            amountCents: spec.amountCents,
            currency: spec.currency,
            description: spec.description,
            idempotencyKey: spec.idempotencyKey,
            metadata: { ...spec.metadata },
          }),
        )
      }
    } catch (error) {
      console.error('NuggPool: could not open payments for match %s: %o', matchId, error)
      await this.abortMatch(matchId, 'could not reach the payment processor')
      return
    }

    const ledger = openLedger(
      settlement,
      { matchId, cell: record.cell },
      created.map((intent) => intent.id),
    )
    await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, { ...record, ledger })

    for (const { ws, state } of this.matchSockets(matchId)) {
      const index = specs.findIndex((spec) => spec.role === state.role)
      if (index === -1) continue
      this.send(ws, {
        type: 'payment_required',
        matchId,
        amountCents: specs[index].amountCents,
        clientSecret: created[index].clientSecret,
      })
    }
  }

  /**
   * Call off a match that cannot be charged for at all.
   *
   * Both buddies drop to idle rather than back into the queue, for the same
   * reason `cancelMatch` does: requeueing two still-connected buyers in a pool
   * that cannot take money would pair them again on the spot and refuse them
   * again, forever.
   */
  private async abortMatch(matchId: string, why: string): Promise<void> {
    const record = await this.ctx.storage.get<MatchRecord>(`match:${matchId}`)
    let retired = record
    if (record?.ledger !== undefined) {
      // Defensive: reaching here with a ledger means charges were opened and then
      // something failed, so anything collected goes back.
      const settled = await this.settleRefunds(matchId, record.ledger)
      retired = { ...record, ledger: settled.ledger }
      await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, retired)
    }

    for (const peer of this.matchSockets(matchId)) {
      this.fail(peer.ws, 'payment_unavailable', why)
      this.setState(peer.ws, principalOf(peer.state))
    }
    await this.retireMatch(matchId, retired, 'payment_unavailable')
    this.broadcastWaiting()
    await this.scheduleSweep()
  }

  /**
   * Fold a payment result into the match that owns it.
   *
   * The Worker has already verified the Stripe signature; this re-validates the
   * body anyway and then leans on the ledger for replay safety, so a webhook
   * delivered twice cannot clear a match twice or refund twice.
   */
  private async handlePaymentEvent(request: Request): Promise<Response> {
    const outcome = parsePaymentOutcome(await request.text())
    if (outcome === null) return Response.json({ error: 'bad payment event' }, { status: 400 })

    const record = await this.ctx.storage.get<MatchRecord>(`match:${outcome.matchId}`)
    // A match this pool no longer has may still owe somebody money: the other
    // half declined, this half cleared two seconds later behind 3DS, and the
    // record was deleted in between. `retireMatch` left the charges behind for
    // exactly this, so look there before answering `unknown_match`.
    if (record?.ledger === undefined) return await this.handleLatePaymentEvent(outcome)

    const { ledger, effect } = applyPaymentOutcome(record.ledger, outcome)
    await this.ctx.storage.put<MatchRecord>(`match:${outcome.matchId}`, { ...record, ledger })

    switch (effect.kind) {
      case 'cleared':
        this.releasePickupCode({ ...record, ledger })
        break
      case 'unwind':
        await this.unwindMatch({ ...record, ledger }, effect.failedRole, effect.refund)
        break
      case 'late_refund': {
        // Defensive: a live record whose ledger is already closed should not
        // exist — `retireMatch` writes the closed copy to a tombstone and deletes
        // the record in the same tick, and a Durable Object runs one event at a
        // time. Refund anyway rather than sit on money for a dead match.
        const settled = await this.settleRefunds(outcome.matchId, ledger, effect.refund)
        await this.ctx.storage.put<MatchRecord>(`match:${outcome.matchId}`, {
          ...record,
          ledger: settled.ledger,
        })
        break
      }
      default:
        break
    }

    return Response.json({ ok: true, effect: effect.kind })
  }

  /**
   * A payment result for a match this pool has already torn down.
   *
   * The case that used to lose a customer $4.49: two buyers confirm cards in
   * parallel, the orderer's declines, the match is unwound, and the receiver's
   * clears a moment later behind 3DS. The record is gone, so there is nothing to
   * clear and nobody to tell — but there is a charge, and no box, so the money
   * goes back.
   *
   * A tombstone is money and never a match. Nothing here touches a socket, reads
   * a pickup code (it does not carry one) or can reach `completeMatch` (which
   * takes a `MatchRecord`). It only ever refunds, and remembers what it could
   * not refund.
   */
  private async handleLatePaymentEvent(outcome: PaymentOutcomeRequest): Promise<Response> {
    const key = `${TOMBSTONE_PREFIX}${outcome.matchId}`
    const tombstone = await this.ctx.storage.get<PaymentTombstone>(key)
    if (tombstone === undefined) {
      // Already settled, never ours, or a match that owed nothing when it died.
      // Acknowledge so Stripe stops retrying a delivery nobody is waiting for.
      return Response.json({ ok: true, effect: 'unknown_match' })
    }

    const { ledger, effect } = applyPaymentOutcome(tombstone.ledger, outcome)
    const owed = effect.kind === 'late_refund' ? effect.refund : []
    const settled = await this.settleRefunds(outcome.matchId, ledger, owed)
    const next = retireLedger(settled.ledger, tombstone.retiredAt)
    // Nothing left to land and nothing left owed: the tombstone has done its job.
    if (next === null) await this.ctx.storage.delete(key)
    else await this.ctx.storage.put<PaymentTombstone>(key, next)

    return Response.json({
      ok: true,
      effect: effect.kind,
      late: true,
      refundedCents: settled.refunded.reduce((sum, leg) => sum + leg.amountCents, 0),
      heldCents: collectedCents(settled.ledger),
    })
  }

  /**
   * Both halves paid: hand the orderer the code and let the handoff begin.
   *
   * The code is the random one the match was struck with, sent to the orderer
   * alone — payment decides *when* it is released, never *who* gets it. The
   * receiver is told the match cleared so their screen can move on to asking for
   * it, and is told nothing else.
   */
  private releasePickupCode(record: MatchRecord): void {
    for (const peer of this.matchSockets(record.matchId)) {
      this.send(peer.ws, {
        type: 'payment_cleared',
        matchId: record.matchId,
        pickupCode: peer.state.role === 'orderer' ? record.pickupCode : null,
      })
    }
  }

  /**
   * A half will never be paid, so there is no box.
   *
   * The buyer who paid is requeued, having done nothing wrong; the one whose card
   * failed drops to idle and has to join again deliberately, so a permanently
   * declining card cannot loop through the same match forever.
   */
  private async unwindMatch(
    record: MatchRecord,
    failedRole: BuyerRole,
    owed: PaymentLeg[],
  ): Promise<void> {
    // Refund first, then say what happened: what a buyer is told has to be what
    // Stripe actually did, not what this pool intended to ask for.
    const settled =
      record.ledger === undefined
        ? { ledger: undefined, refunded: [] as PaymentLeg[], held: [] as PaymentLeg[] }
        : await this.settleRefunds(record.matchId, record.ledger, owed)
    const retired: MatchRecord =
      settled.ledger === undefined ? record : { ...record, ledger: settled.ledger }

    for (const peer of this.matchSockets(record.matchId)) {
      const mine = centsFor(settled.refunded, peer.state.role)
      this.send(peer.ws, {
        type: 'payment_failed',
        matchId: record.matchId,
        whose: peer.state.role === failedRole ? 'you' : 'buddy',
        refunded: mine > 0,
        refundedCents: mine,
        heldCents: centsFor(settled.held, peer.state.role),
      })
      if (peer.state.role === failedRole) {
        this.setState(peer.ws, principalOf(peer.state))
        continue
      }
      const now = Date.now()
      this.setState(peer.ws, {
        ...identityOf(peer.state),
        status: 'waiting',
        // At the back of the queue, so they do not jump buyers who waited honestly.
        joinedAt: now,
        lastSeenAt: now,
        warned: false,
      })
    }

    await this.retireMatch(record.matchId, retired, 'payment_failed')
    this.broadcastWaiting()
    await this.scheduleSweep()
  }

  /**
   * Delete a match record, leaving behind whatever its money still needs.
   *
   * **The only place a `match:` key is removed.** Four paths tear a match down
   * (a declined half, a cancellation, an abort, a disconnect) and every one of
   * them used to delete the record itself — which is what made
   * `applyPaymentOutcome`'s late-success refund unreachable from its only caller,
   * and would have made it unreachable again the next time a teardown path was
   * added. One chokepoint, so the tombstone cannot be forgotten;
   * `test/payments.test.ts` asserts there is still only one.
   *
   * A **settled** split is the one case that leaves nothing behind. Its charges
   * are revenue, not unfinished business: every leg succeeded (that is what
   * unlocked the pickup in the first place) and none of it is owed back, so a
   * tombstone would be a permanent claim that this pool owes somebody money it
   * does not. Derived from the record rather than passed in by the caller,
   * because a flag at six call sites is a flag that will eventually be wrong.
   *
   * `reason` is the exception, and only because it is genuinely *not* derivable:
   * every non-dispute teardown leaves the record in the identical `pending`
   * state, and which one it was is the only thing that tells an operator what
   * happened to the two people whose money is stuck. It is required rather than
   * optional for the same reason the `earned` flag is derived — so a seventh
   * call site cannot get it wrong by omission; it will not compile. And it is a
   * *reason*, never a "file a hold" boolean: the decision itself stays here, at
   * the chokepoint, where `holdsCollectedMoney` is also checked.
   *
   * The D1 write happens before the record is deleted, for the same reason
   * `persistTerminal` runs before its delete — a tombstone lives in one cell's
   * storage, and no query can reach across cells to find it.
   */
  private async retireMatch(
    matchId: string,
    record: MatchRecord | undefined,
    reason: TeardownReason,
  ): Promise<void> {
    const earned = record?.status === 'complete'
    const tombstone =
      record?.ledger === undefined || earned ? null : retireLedger(record.ledger, Date.now())
    if (tombstone !== null) {
      await this.ctx.storage.put<PaymentTombstone>(`${TOMBSTONE_PREFIX}${matchId}`, tombstone)
      // Only a non-dispute teardown, and only one Stripe would not empty. A
      // tombstone whose legs are all still `pending` is a webhook to wait for,
      // not money anybody is out of pocket for, and a dispute's hold is
      // deliberate and already recorded in `disputes` — folding it in here
      // would put the same money in two operator queues.
      const held = parseHoldReason(reason)
      if (held !== null && record !== undefined && holdsCollectedMoney(tombstone.ledger)) {
        await this.fileHold(heldMatchFrom(record, tombstone, held))
      }
    }
    await this.ctx.storage.delete(`match:${matchId}`)
  }

  /**
   * Mirror a hold into D1, or keep it until D1 will take it.
   *
   * Swallowed rather than rethrown, exactly like `persistTerminal`: a refund
   * the processor refused must not also cost two buyers the teardown that tells
   * them what happened. What is emphatically *not* swallowed is the record of
   * it — the row is parked under `PENDING_HOLD_PREFIX` and replayed off the
   * next alarm, because until D1 has it the only trace that this cell is
   * sitting on somebody's money is this one object's storage, which no operator
   * can enumerate.
   */
  private async fileHold(held: HeldMatch): Promise<void> {
    const key = `${PENDING_HOLD_PREFIX}${held.matchId}`
    try {
      await writeHeldMatch(this.env.DB, held)
      await this.ctx.storage.delete(key)
    } catch (error) {
      console.error('hold write failed', held.matchId, held.heldCents, error)
      await this.ctx.storage.put<HeldMatch>(key, held)
    }
  }

  /**
   * Retry the D1 write for any hold still parked in storage.
   *
   * The holds counterpart of `reconcileTerminal`, and it needs its own pass for
   * one reason: a hold is filed for a match whose status is still `pending`,
   * and that reconciliation deliberately skips those. Opportunistic rather than
   * scheduled, for the same reason — nobody is waiting on it, and an alarm
   * armed for the retry itself would keep waking a cell on a permanent failure
   * with nothing new to try.
   */
  private async reconcileHolds(): Promise<void> {
    const parked = await this.ctx.storage.list<HeldMatch>({ prefix: PENDING_HOLD_PREFIX })
    for (const held of parked.values()) await this.fileHold(held)
  }

  /**
   * Try a refund this cell already failed to make, at an operator's asking.
   *
   * Everything about *which* money is owed comes off the tombstone, not the
   * request: the only thing crossing this boundary is which match, because
   * there is nothing to decide. Re-asking is safe any number of times because
   * every refund is keyed on `refundIdempotencyKey`, and a leg Stripe has
   * already handed back is stamped `refunded` and is no longer owed.
   *
   * Like `handleLatePaymentEvent` and `handleDisputeResolution`, this touches no
   * socket, reads no pickup code and cannot reach `completeMatch`.
   */
  private async handleHoldRetry(request: Request): Promise<Response> {
    const ask = parseHoldRetryRequest(await request.text())
    if (ask === null) return Response.json({ error: 'bad hold retry' }, { status: 400 })

    const key = `${TOMBSTONE_PREFIX}${ask.matchId}`
    const tombstone = await this.ctx.storage.get<PaymentTombstone>(key)
    // Nothing left to hand back: a late webhook already answered for it, or
    // this cell never had it. Not a failure — the hold is simply over, and
    // saying so is what lets the caller close the row.
    if (tombstone === undefined) return Response.json({ ok: true, refundedCents: 0, heldCents: 0 })

    const settled = await this.settleRefunds(ask.matchId, tombstone.ledger)
    const next = retireLedger(settled.ledger, tombstone.retiredAt)
    // Nothing left to land and nothing left owed: the tombstone has done its job.
    if (next === null) await this.ctx.storage.delete(key)
    else await this.ctx.storage.put<PaymentTombstone>(key, next)

    return Response.json({
      ok: true,
      refundedCents: settled.refunded.reduce((sum, leg) => sum + leg.amountCents, 0),
      // What is still sitting in the account after this attempt. A refund
      // refused again leaves the figure where it was, and the row stays open.
      heldCents: collectedCents(settled.ledger),
    })
  }

  /**
   * Hand money back for legs collected against a match that is off, and report
   * what Stripe actually agreed to.
   *
   * `refunded` is what was confirmed; `held` is what was owed and is still
   * sitting in the account. The distinction is the whole point: the legs are
   * stamped `refunded` only *after* the call, so a stuck refund leaves the record
   * saying `succeeded` — money collected, not returned — instead of erasing the
   * one piece of evidence a human reconciling it would need.
   */
  private async settleRefunds(
    matchId: string,
    ledger: PaymentLedger,
    owed: PaymentLeg[] = refundableLegs(ledger),
  ): Promise<{ ledger: PaymentLedger; refunded: PaymentLeg[]; held: PaymentLeg[] }> {
    const refunded = await this.refund(owed, matchId)
    const confirmed = new Set(refunded.map((leg) => leg.paymentIntentId))
    return {
      ledger: markRefunded(ledger, refunded),
      refunded,
      held: owed.filter((leg) => !confirmed.has(leg.paymentIntentId)),
    }
  }

  /**
   * Ask Stripe to hand money back, and return only the legs it confirmed.
   *
   * A refund that fails is a money problem for a human, not a reason to leave the
   * buyer staring at a dead match — so the loop continues. But it is also not a
   * refund, so it is not reported as one: the leg is simply absent from what this
   * returns, and every caller derives what it tells the buyer from that.
   */
  private async refund(legs: PaymentLeg[], matchId: string): Promise<PaymentLeg[]> {
    const stripe = this.stripe
    if (legs.length === 0) return []
    if (stripe === null) {
      // A secret rotated away mid-match. Nothing was refunded, and saying
      // otherwise would be the lie this function exists to stop telling.
      console.error(
        'NuggPool: cannot refund %d leg(s) of match %s — Stripe is not configured',
        legs.length,
        matchId,
      )
      return []
    }
    const refunded: PaymentLeg[] = []
    for (const leg of legs) {
      try {
        await refundPaymentIntent(stripe, {
          paymentIntentId: leg.paymentIntentId,
          idempotencyKey: refundIdempotencyKey(matchId, leg.role),
        })
        refunded.push(leg)
      } catch (error) {
        console.error(
          'NuggPool: refund FAILED for %s (%s), %d cents still held: %o',
          matchId,
          leg.role,
          leg.amountCents,
          error,
        )
      }
    }
    return refunded
  }

  /** Seat a buyer in the queue, alive as of now, and arm the cell's alarm. */
  private async enqueue(ws: WebSocket, identity: BuyerIdentity): Promise<void> {
    const waiting: WaitingState = {
      ...identity,
      status: 'waiting',
      lastSeenAt: Date.now(),
      warned: false,
    }
    this.setState(ws, waiting)
    this.broadcastWaiting()
    await this.scheduleSweep()
  }

  /**
   * Treat a ping as a sign of life, which is what keeps a buyer who is sitting
   * on the page from being aged out mid-wait. A buyer who speaks up after being
   * warned is forgiven, so the warning can be sent again later.
   *
   * No rescheduling here on purpose: a queued entry always has an alarm armed at
   * or before its old deadline, so that alarm fires, finds nothing due, and
   * re-arms — and pings stay cheap, which matters because they are constant.
   */
  private refreshLiveness(ws: WebSocket): void {
    const state = this.getState(ws)
    if (state === null || state.status !== 'waiting') return
    this.setState(ws, { ...state, lastSeenAt: Date.now(), warned: false })
  }

  /**
   * Record one side of the handoff, and settle only when both sides are in.
   *
   * The receiver has to produce the orderer's code; the orderer taps. Neither
   * side can complete a match alone, and a wrong code is an error rather than a
   * quiet no-op, so a receiver who mistyped knows to look again.
   */
  private async handleConfirmPickup(ws: WebSocket, code: string | null): Promise<void> {
    const state = this.getState(ws)
    if (state === null) return
    if (state.status !== 'matched') {
      this.fail(ws, 'not_matched', 'you are not in a match to confirm')
      return
    }

    const record = await this.ctx.storage.get<MatchRecord>(`match:${state.matchId}`)
    if (record === undefined) {
      this.fail(ws, 'not_matched', 'that match is no longer live')
      return
    }
    if (record.status === 'disputed') {
      this.fail(ws, 'match_disputed', 'this match is disputed and cannot be confirmed')
      return
    }
    if (record.status === 'complete') {
      this.fail(ws, 'already_confirmed', 'this match is already settled')
      return
    }
    // Money before nuggets. Both sides confirming is the only route to a D1
    // ledger row (`completeMatch`), so refusing here is what keeps a half-paid
    // match from reaching one — and the receiver could not have the code to
    // confirm with anyway, because it has not been released.
    if (!pickupUnlocked(record)) {
      this.fail(ws, 'payment_pending', 'both halves have to clear before the handoff')
      return
    }
    if (record.confirmations[state.role] !== null) {
      this.fail(ws, 'already_confirmed', 'you already confirmed this handoff')
      return
    }
    // Validated against the stored code, never against anything the client was
    // told: the orderer's own receipt is the only place this code exists.
    if (state.role === 'receiver' && code !== record.pickupCode) {
      this.fail(ws, 'bad_pickup_code', "that is not your bud's pickup code")
      return
    }

    const at = Date.now()
    record.confirmations[state.role] = at
    const settled = bothConfirmed(record.confirmations)
    await this.ctx.storage.put(`match:${state.matchId}`, record)

    const deadline = disputeDeadline(record.confirmations, this.pickupTimeoutMs)
    for (const peer of this.matchSockets(record.matchId)) {
      this.send(peer.ws, {
        type: 'pickup_confirmed',
        matchId: record.matchId,
        by: state.role,
        waitingOn: pendingRole(record.confirmations),
        disputeAt: deadline,
      })
    }

    if (settled) {
      await this.completeMatch(record, at)
      return
    }
    await this.scheduleSweep()
  }

  /**
   * Both sides confirmed: book the split and let both buddies go.
   *
   * This is the only place a settled ledger row is written. Anything that has
   * not been confirmed by both sides is live state, and live state belongs to
   * this object rather than to D1.
   */
  private async completeMatch(record: MatchRecord, at: number): Promise<void> {
    record.status = 'complete'
    record.settledAt = at
    await this.ctx.storage.put(`match:${record.matchId}`, record)

    const durable = await this.persistTerminal(record)

    // Both of them turned up, which is the only thing that raises a completion.
    await this.recordStanding([
      { userId: record.orderer.userId, event: 'completed' },
      { userId: record.receiver.userId, event: 'completed' },
    ])

    for (const peer of this.matchSockets(record.matchId)) {
      this.send(peer.ws, { type: 'pickup_complete', matchId: record.matchId, settledAt: at })
      // Free to queue for the next box.
      this.setState(peer.ws, principalOf(peer.state))
    }
    // Only once the row exists somewhere that outlives this cell. A settled
    // split that is still only in Durable Object storage is the one thing this
    // object is not allowed to lose, so a failed write keeps the record and
    // `reconcileTerminal` retries it.
    if (durable) await this.retireMatch(record.matchId, record, 'settled')
    await this.scheduleSweep()
  }

  /**
   * One side confirmed and the other never did.
   *
   * Nothing is written to the settled ledger: a split where one buddy says the
   * handoff happened and the other says nothing is not revenue. It is filed in
   * `disputes` instead — a queue for a human, not a report — because the state
   * this used to leave behind was a dead end: a record in one cell's storage
   * that nobody could see and neither buyer could be made whole from.
   *
   * Callers re-arm the alarm afterwards.
   *
   * Answers whether the record was retired (i.e. `persistTerminal` landed and
   * `retireMatch` ran), so a caller iterating its own snapshot of `match:` —
   * `alarm`'s dispute-timeout sweep — knows to drop it from that snapshot
   * rather than have `reconcileTerminal` persist the same dispute twice.
   */
  private async disputeMatch(
    record: MatchRecord,
    at: number,
    reason: DisputeReason,
    except?: WebSocket,
  ): Promise<boolean> {
    record.status = 'disputed'
    record.disputedAt = at
    record.disputedReason = reason
    await this.ctx.storage.put(`match:${record.matchId}`, record)
    if (record.ledger !== undefined && collectedCents(record.ledger) > 0) {
      // Deliberately NOT refunded. A dispute means one buddy says the nuggets
      // changed hands and the other says nothing; auto-refunding would make "stay
      // silent after collecting the box" the cheapest way to eat for free. The
      // money is held against the stored record, which is what a human
      // reconciles from — the same reason no ledger row is written.
      console.warn(
        'NuggPool: match %s disputed holding %d cents for reconciliation',
        record.matchId,
        collectedCents(record.ledger),
      )
    }

    // Before either buddy is told, so a dispute is never visible on a screen
    // while being invisible to the human who has to resolve it.
    const durable = await this.persistTerminal(record)

    // One side said the handoff happened and the other never answered. The
    // silent side is the no-show — this is the one place the protocol has
    // evidence about *which* buddy did not turn up, because the other one
    // confirmed. A dispute with nobody confirmed does not reach here at all.
    const missing = pendingRole(record.confirmations)
    if (missing !== null) {
      await this.recordStanding([{ userId: record[missing].userId, event: 'no_show' }])
    }

    const confirmedBy = confirmedRole(record.confirmations)
    const heldFor = (role: BuyerRole) =>
      record.ledger === undefined ? 0 : centsFor(refundableLegs(record.ledger), role)
    for (const peer of this.matchSockets(record.matchId, except)) {
      this.send(peer.ws, {
        type: 'pickup_disputed',
        matchId: record.matchId,
        confirmedBy,
        reason,
        // Said out loud rather than left to a code comment: this is the one
        // teardown that deliberately does *not* refund, so the buyer has to be
        // told their money is being held rather than left to infer it from
        // "flagged for review".
        heldCents: heldFor(peer.state.role),
      })
      this.setState(peer.ws, principalOf(peer.state))
    }

    // The money stays behind as a tombstone rather than in the match record:
    // `retireMatch` is what keeps it answerable once the record is gone, and
    // it is the same money `disputes.held_cents` just told a human about.
    if (durable) await this.retireMatch(record.matchId, record, 'disputed')
    return durable
  }

  /**
   * Act on an operator's resolution, for the one part of it this object owns:
   * the money.
   *
   * The decision, who made it and when all live in D1, written before this is
   * called. All that is left here is the refund the resolution implies, against
   * the tombstone the disputed match left behind — which is the only place a
   * dead match's charges still exist.
   *
   * Like `handleLatePaymentEvent`, this deliberately touches no socket, reads no
   * pickup code and cannot reach `completeMatch`: a resolution must never be a
   * second route to a code or to a settled ledger row.
   */
  private async handleDisputeResolution(request: Request): Promise<Response> {
    const ask = parseDisputeRefundRequest(await request.text())
    if (ask === null) return Response.json({ error: 'bad dispute resolution' }, { status: 400 })

    const roles = new Set(refundedRoles(ask.resolution))
    const key = `${TOMBSTONE_PREFIX}${ask.matchId}`
    const tombstone = await this.ctx.storage.get<PaymentTombstone>(key)
    // Nothing was ever collected — an uncharged pool, or a match whose money has
    // already been answered for. "No charge was taken, nothing to refund" is a
    // real outcome, not a failure.
    if (tombstone === undefined || roles.size === 0) {
      // Nothing owed, so nothing outstanding: this resolution is finished the
      // moment it is decided, and the row it stamps is not one to retry.
      return Response.json({ ok: true, refundedCents: 0, heldCents: 0, outstandingCents: 0 })
    }

    const owed = refundableLegs(tombstone.ledger).filter((leg) => roles.has(leg.role))
    const settled = await this.settleRefunds(ask.matchId, tombstone.ledger, owed)
    const next = retireLedger(settled.ledger, tombstone.retiredAt)
    // Nothing left to land and nothing left owed: the tombstone has done its job.
    if (next === null) await this.ctx.storage.delete(key)
    else await this.ctx.storage.put<PaymentTombstone>(key, next)

    return Response.json({
      ok: true,
      refundedCents: settled.refunded.reduce((sum, leg) => sum + leg.amountCents, 0),
      // What is still sitting in the account after this: a refund Stripe refused
      // leaves money held, and saying so is the whole point of the distinction.
      heldCents: collectedCents(settled.ledger),
      // What *this resolution* still owes, which is a narrower figure than the
      // one above and the only one a retry can act on: `settled` holds both
      // halves on purpose and owes nothing, and `refund_orderer` leaves the
      // receiver's half collected by design. Money this resolution promised to
      // hand back and Stripe would not — nothing else.
      outstandingCents: settled.held.reduce((sum, leg) => sum + leg.amountCents, 0),
    })
  }

  private async handleCancel(ws: WebSocket): Promise<void> {
    const state = this.getState(ws)
    if (state === null) return
    if (state.status !== 'waiting') {
      this.fail(ws, 'not_waiting', 'nothing to cancel')
      return
    }
    this.setState(ws, principalOf(state))
    // One fewer dot on everyone else's map.
    this.broadcastWaiting()
    await this.scheduleSweep()
  }

  /**
   * Drop a connection, and if it was half of a match, return the abandoned
   * buddy to the queue rather than leaving them staring at a dead match.
   *
   * Unless somebody already confirmed the handoff: requeueing then would erase a
   * claim that the nuggets changed hands, so that is a dispute, not an
   * abandonment.
   */
  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const state = this.getState(ws)
    if (state === null) return
    if (
      state.status === 'matched' &&
      // One of this person's tabs closing is not a buddy walking away. Since
      // #101 a browser can hold more than one socket on the same side of a match
      // — the handoff link opens in a new tab — so a match is abandoned only
      // when the *last* socket on this side goes. Without this, closing the tab
      // the camera opened would dispute or tear down the match it just joined.
      this.matchSockets(state.matchId, ws).some((peer) => peer.state.role === state.role)
    ) {
      return
    }
    if (state.status !== 'matched') {
      // A waiting buyer who simply closed the tab still needs to fall out of
      // everyone else's roster — and may have been the last thing keeping this
      // cell's alarm armed.
      if (state.status === 'waiting') {
        this.broadcastWaiting()
        await this.scheduleSweep()
      }
      return
    }

    const record = await this.ctx.storage.get<MatchRecord>(`match:${state.matchId}`)
    if (
      record !== undefined &&
      record.status === 'pending' &&
      confirmedRole(record.confirmations) !== null
    ) {
      await this.disputeMatch(record, Date.now(), 'buddy_left', ws)
      await this.scheduleSweep()
      return
    }

    // Nobody confirmed, so nobody has a box — anything collected goes back. The
    // buyer who stayed has paid for an order that is not being placed, and the one
    // who walked away has paid for nothing at all.
    let retired = record
    let held: PaymentLeg[] = []
    if (record?.ledger !== undefined) {
      const settled = await this.settleRefunds(state.matchId, record.ledger)
      retired = { ...record, ledger: settled.ledger }
      held = settled.held
      await this.ctx.storage.put<MatchRecord>(`match:${state.matchId}`, retired)
    }
    // Matched, nobody had confirmed anything, and this is the socket that went
    // away: a cancellation after a match, charged to whoever walked. Unlike the
    // expiry path above there is no guessing here — the connection that closed
    // is the one being counted.
    await this.recordStanding([{ userId: state.userId, event: 'late_cancel' }])

    for (const other of this.states()) {
      if (other.ws === ws) continue
      if (other.state.status !== 'matched' || other.state.matchId !== state.matchId) continue

      const now = Date.now()
      const requeued: WaitingState = {
        ...identityOf(other.state),
        status: 'waiting',
        // Requeued at the back, so they do not jump buyers who waited honestly.
        joinedAt: now,
        // Alive as of now: their wait starts over, not where the match left it.
        lastSeenAt: now,
        warned: false,
      }
      this.setState(other.ws, requeued)
      this.send(other.ws, {
        type: 'buddy_left',
        matchId: state.matchId,
        // Almost always zero: the ordinary refund succeeds. Non-zero only when
        // Stripe refused this survivor's refund — the same rare case the other
        // three teardown frames already say out loud, see `heldCents` on
        // `PaymentFailedMessage`/`MatchExpiredMessage`/`PickupDisputedMessage`.
        heldCents: centsFor(held, other.state.role),
      })
    }

    await this.retireMatch(state.matchId, retired, 'buddy_left')
    // Without this the survivor's UI would keep showing the pool count (and
    // buddy dots) from before they were matched, which for an instant match
    // is zero — and it also tells everyone nearby about the buyer who just got
    // requeued.
    this.broadcastWaiting()
    // The requeued buddy is back under the queue's idle timer, and the match's
    // own deadline is gone with the record.
    await this.scheduleSweep()
  }

  /**
   * Tell a queued buyer where they stand. Called after the state is committed,
   * so the count includes the buyer being told.
   *
   * Everything here is scoped to this buyer's radius rather than to the shard.
   * The shard is ~156 km across (see `DEFAULT_POOL_CELL_PRECISION`), so a
   * shard-wide count is a number about sharding and a shard-wide roster is a
   * much larger privacy surface than the map it draws — a buyer fifty miles
   * away, who could never be matched here, is simply invisible.
   */
  private sendWaiting(ws: WebSocket, state: WaitingState): void {
    const nearby = this.withinRadius(state, state.connId)
    const eligible = nearby.filter((o) => o.state.dealId === state.dealId)
    // The map roster is every deal within the radius, not just this buyer's: one
    // market can host more than one deal's queue at once, and the point of the
    // map is to explain the market rather than to show who could pair.
    const buddies = nearby
      // Quantized here, at the one chokepoint every waiting broadcast passes
      // through, so a buyer's exact position never reaches the wire.
      .map((o) => snapToGrid(o.state))

    this.send(ws, {
      type: 'waiting',
      waiting: eligible.length + 1,
      queuedAhead: eligible.filter((o) => o.state.joinedAt < state.joinedAt).length,
      buddies,
    })
  }

  /**
   * The waiting buyers inside the match radius of a point, optionally excluding
   * one connection (normally the buyer being told).
   *
   * The one place "who is nearby" is decided, so a count, a roster and the
   * matcher's candidate set cannot drift apart. It answers only *which* buyers
   * are eligible — never which one wins, which is `findMatch`'s fairness rule
   * and deliberately kept separate from this.
   */
  private withinRadius(
    at: LatLng,
    exceptConnId?: string,
  ): { ws: WebSocket; state: WaitingState }[] {
    const radius = this.radiusMeters
    return this.waitingStates().filter(
      ({ state }) =>
        state.connId !== exceptConnId &&
        distanceMeters(at, { lat: state.lat, lng: state.lng }) <= radius,
    )
  }

  /**
   * This tick's one read of the `match:` keyspace (#87), keyed by **bare
   * `matchId`** rather than by the `match:<id>` storage key `list()` hands back.
   *
   * The rekey is the whole point: every phase threaded this map (`alarm`,
   * `reconcileTerminal`, `sweepExpired`) prunes an entry it just retired so a
   * later phase cannot replay a write that already landed, and each of them has
   * only a `matchId` in hand. `Map.delete` on an absent key is a silent `false`,
   * so keying by the storage key made all three prunes no-ops that nothing —
   * not `tsc`, not a unit test — could see. Rekeying once here is why no call
   * site has to remember the prefix.
   */
  private async matchRecords(): Promise<Map<string, MatchRecord>> {
    const listed = await this.ctx.storage.list<MatchRecord>({ prefix: 'match:' })
    return new Map([...listed.values()].map((record) => [record.matchId, record]))
  }

  /**
   * Drop tombstones that are waiting for a webhook that will never come.
   *
   * A tombstone still holding collected cents is never dropped: that one is the
   * record of money this pool failed to hand back, and deleting it would lose the
   * only trace of it. Opportunistic rather than scheduled — a cell with nothing
   * but a tombstone arms no alarm, and does not need to: there is nothing due.
   */
  private async sweepTombstones(now: number): Promise<void> {
    const tombstones = await this.ctx.storage.list<PaymentTombstone>({ prefix: TOMBSTONE_PREFIX })
    for (const [key, tombstone] of tombstones) {
      if (collectedCents(tombstone.ledger) > 0) continue
      if (now - tombstone.retiredAt < TOMBSTONE_RETENTION_MS) continue
      await this.ctx.storage.delete(key)
    }
  }

  /**
   * The standing bands for a set of buyers, or nothing at all.
   *
   * A reputation outage leaves the map empty, which makes every candidate rank as
   * unrated and drops matching back to pure first-come-first-served — exactly
   * what it did before standing existed. Failing that way round matters: nobody
   * should be unable to buy nuggets because a courtesy read timed out.
   */
  private async standingsFor(userIds: readonly string[]): Promise<Map<string, StandingBand>> {
    try {
      return await readStandings(this.env.DB, userIds)
    } catch (error) {
      console.error('standing read failed', error)
      return new Map()
    }
  }

  /**
   * Book what a match said about its buyers.
   *
   * Swallowed the way the ledger write is, and for a stronger reason: a split that
   * settled is money, while a counter is a courtesy. Nothing about the handshake,
   * the receipt or the queue depends on this landing.
   */
  private async recordStanding(updates: readonly ReputationUpdate[]): Promise<void> {
    try {
      await recordReputation(this.env.DB, updates)
    } catch (error) {
      console.error('reputation write failed', error)
    }
  }

  /**
   * Re-arm the cell's single alarm at the earliest of everything outstanding —
   * and delete it when nothing is, so a cell nobody is using is never woken to
   * do nothing.
   *
   * The two match deadlines are computed from disjoint sets and that is what
   * keeps them from competing: `disputeDeadline` is null until somebody
   * confirms, and `expirableMatches` drops a match the moment somebody does.
   *
   * `records` lets `alarm` pass through its one `match:` read for the tick
   * instead of this doing a fifth list (#87); every other caller re-arms the
   * alarm after its own single-key write and has no tick-scoped map to share,
   * so it is optional and falls back to listing for itself.
   */
  private async scheduleSweep(records?: Map<string, MatchRecord>): Promise<void> {
    const now = Date.now()
    const matchRecords = [...(records ?? (await this.matchRecords())).values()]

    let next: number | null = null
    const dueAt = (at: number | null) => {
      if (at === null) return
      if (next === null || at < next) next = at
    }

    for (const record of matchRecords) {
      if (record.status !== 'pending') continue
      dueAt(disputeDeadline(record.confirmations, this.pickupTimeoutMs))
    }

    const plan = planSweep(
      now,
      this.waitingStates().map(({ state }) => livenessOf(state)),
      expirableMatches(matchRecords),
      this.windows,
    )
    dueAt(nextAlarmAt(now, plan))

    const current = await this.ctx.storage.getAlarm()
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    // An alarm that is already earlier is harmless — it fires, finds nothing
    // due, and re-arms from here — so only ever pull the wake-up forward.
    if (current === null || current > next) await this.ctx.storage.setAlarm(next)
  }

  /** The live sockets on both sides of a match, optionally skipping one. */
  private matchSockets(
    matchId: string,
    except?: WebSocket,
  ): { ws: WebSocket; state: MatchedState }[] {
    const out: { ws: WebSocket; state: MatchedState }[] = []
    for (const { ws, state } of this.states()) {
      if (ws === except) continue
      if (state.status !== 'matched' || state.matchId !== matchId) continue
      out.push({ ws, state })
    }
    return out
  }

  /**
   * Refresh every waiting socket's roster after a join, cancel or disconnect.
   *
   * Every socket in the shard is told, but each is told only about its own
   * radius: `sendWaiting` re-derives "nearby" from the recipient, so two buyers
   * in one shard and forty miles apart get genuinely different rosters.
   */
  private broadcastWaiting(): void {
    for (const { ws, state } of this.waitingStates()) {
      this.sendWaiting(ws, state)
    }
  }

  private states(): { ws: WebSocket; state: ConnState }[] {
    const out: { ws: WebSocket; state: ConnState }[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.getState(ws)
      if (state !== null) out.push({ ws, state })
    }
    return out
  }

  private waitingStates(): { ws: WebSocket; state: WaitingState }[] {
    const out: { ws: WebSocket; state: WaitingState }[] = []
    for (const { ws, state } of this.states()) {
      if (state.status === 'waiting') out.push({ ws, state })
    }
    return out
  }

  private getState(ws: WebSocket): ConnState | null {
    return (ws.deserializeAttachment() as ConnState | null) ?? null
  }

  private setState(ws: WebSocket, state: ConnState): void {
    ws.serializeAttachment(state)
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message))
  }

  private fail(ws: WebSocket, code: ProtocolErrorCode, message: string): void {
    this.send(ws, { type: 'error', code, message })
  }
}

/** The liveness view of a queue entry, which is all the expiry rule needs. */
function livenessOf(state: WaitingState): QueueEntry {
  return { id: state.connId, lastSeenAt: state.lastSeenAt, warned: state.warned }
}

/**
 * The matches the expiry sweep is allowed to cancel: struck, and with not one
 * confirmation on them.
 *
 * This filter is the whole reason the two timers coexist. The moment either side
 * confirms, the match acquires a dispute deadline and belongs to `disputeMatch`;
 * expiring it here instead would erase a buddy's claim that the nuggets changed
 * hands, which is the one thing the handshake exists to prevent. A match nobody
 * has confirmed has no dispute deadline at all — `disputeDeadline` returns null
 * for it — so without this sweep it would sit in the cell forever.
 */
function expirableMatches(records: Iterable<MatchRecord>): OpenMatch[] {
  const out: OpenMatch[] = []
  for (const record of records) {
    if (record.status !== 'pending') continue
    if (record.confirmations.orderer !== null || record.confirmations.receiver !== null) continue
    out.push({ matchId: record.matchId, createdAt: record.createdAt })
  }
  return out
}

/** Strip connection status off a state, leaving just who and where the buyer is. */
function identityOf(state: BuyerIdentity): BuyerIdentity {
  const { connId, userId, name, cell, origin, locationSource, dealId, lat, lng, joinedAt } = state
  return {
    connId,
    userId,
    name,
    cell,
    origin,
    locationSource,
    dealId,
    lat,
    lng,
    joinedAt,
    // A socket whose hibernation attachment predates this field has no sauces
    // rather than an undefined pair.
    sauces: state.sauces ?? null,
  }
}

/** Drop back to an idle connection, keeping only the session-derived identity. */
function principalOf(state: Principal): ConnState {
  const { connId, userId, name, cell, origin, locationSource } = state
  return { status: 'idle', connId, userId, name, cell, origin, locationSource }
}

/** What the match record remembers about a buyer once their socket is gone. */
function buyerOf(identity: BuyerIdentity): MatchBuyer {
  const { connId, userId, name } = identity
  return { connId, userId, name }
}

function toCandidate(
  identity: BuyerIdentity,
  standings: ReadonlyMap<string, StandingBand>,
): Candidate {
  const standing = standings.get(identity.userId)
  return {
    id: identity.connId,
    dealId: identity.dealId,
    lat: identity.lat,
    lng: identity.lng,
    joinedAt: identity.joinedAt,
    // Left off rather than defaulted when the read said nothing: absent ranks
    // with `new` in `findMatch`, and a buyer with no history is not the same
    // claim as a read that failed.
    ...(standing === undefined ? {} : { standing }),
  }
}

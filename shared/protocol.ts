import type { BuyerRole, BuyerShare, Settlement } from './economics'
import type { ExpiryWindows } from './expiry'
import type { LocationSource } from './location'
import { normalizePickupCode } from './pickup'
import { SAUCES_PER_SELECTION, type SauceSelection } from './sauces'

/**
 * Wire protocol version. Bump on any breaking message change.
 *
 * 5 put money in front of the pickup code: `matched` no longer carries one even
 * for the orderer while a match is being charged, and the code arrives later on
 * `payment_cleared`. A v4 client would sit on a null code with no idea it was
 * waiting for two cards to clear, which is why this is a bump rather than an
 * additive change.
 */
export const PROTOCOL_VERSION = 5

/**
 * Take a seat in the pool.
 *
 * There is deliberately no `name` here: the display name comes from the session
 * the socket was upgraded with, so a buyer cannot present themselves to a buddy
 * as somebody else.
 *
 * Coordinates are optional, and normally absent. The server resolves a location
 * for the socket at upgrade time — from the edge when the buyer has not turned on
 * precise location — so the common case sends nothing but a deal. A client that
 * does send them has an exact fix the buyer opted into, which sharpens the
 * walking distance inside the cell; it can never change the cell, which was
 * fixed when the socket was upgraded.
 */
export interface JoinMessage {
  type: 'join'
  dealId: string
  lat?: number
  lng?: number
  /**
   * The two sauces this buyer wants, so the one placing the order knows what to
   * ask for. Optional: a buyer who never picked a pair still pairs.
   *
   * Only shape-checked here. Whether these ids name sauces on the joined deal's
   * menu is decided against the catalogue in `worker/pool.ts`, the same division
   * `dealId` follows — a typo and a malformed frame deserve different answers.
   */
  sauces?: readonly [string, string]
}

export interface CancelMessage {
  type: 'cancel'
}

/**
 * Keeps the socket warm, lets the client measure round-trip latency, and — the
 * part the server cares about — refreshes the sender's place in the queue.
 */
export interface PingMessage {
  type: 'ping'
  at: number
}

/**
 * Say the handoff happened.
 *
 * The receiver has to produce the code off the orderer's receipt; the orderer
 * only taps. Which of those applies is decided from the connection's role on
 * the server, so a `code` sent by the orderer is ignored rather than trusted.
 */
export interface ConfirmPickupMessage {
  type: 'confirm_pickup'
  /** The orderer's pickup code as typed by the receiver, normalized. */
  code: string | null
}

export type ClientMessage = JoinMessage | CancelMessage | PingMessage | ConfirmPickupMessage

export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  /** Geohash cell this connection was routed to. */
  cell: string
  /**
   * Which rung of the location fallback produced that cell. The client shows
   * this: a buyer on the demo cell should never be told they were placed
   * precisely.
   */
  locationSource: LocationSource
  waiting: number
  /** Who the server thinks you are, straight off your session. */
  user: {
    id: string
    name: string
  }
  /**
   * The liveness windows this cell enforces. Sent so a client knows how often it
   * has to ping to keep its seat, rather than hardcoding a guess at the server's
   * policy.
   */
  expiry: ExpiryWindows
}

/**
 * Another buyer waiting in your cell, reduced to a dot on a map.
 *
 * Deliberately just coordinates: no `connId`, no `name`. The position itself
 * is already coarse by the time it reaches here — see `snapToGrid` in
 * `shared/geo.ts` — so an unmatched buyer is anonymous and only approximately
 * located, never identifiable and never exact.
 */
export interface CellBuddy {
  lat: number
  lng: number
}

export interface WaitingMessage {
  type: 'waiting'
  /** How many buyers are queued on your deal in this cell, including you. */
  waiting: number
  /** How many eligible buyers joined before you. */
  queuedAhead: number
  /**
   * Everyone else waiting in this cell, on any deal, snapped to a coarse
   * grid — never you. This is the cell's whole roster, not just your deal:
   * the map is explaining the cell as a market, and `waiting`/`queuedAhead`
   * above stay scoped to the deal that actually decides who you pair with.
   */
  buddies: CellBuddy[]
}

export interface MatchedMessage {
  type: 'matched'
  matchId: string
  /** Your role in this match. */
  role: BuyerRole
  /** Your line of the settlement. */
  share: BuyerShare
  /** The whole settlement, so the UI can show the split honestly. */
  settlement: Settlement
  buddy: {
    name: string
    distanceMeters: number
    /**
     * Their sauces, validated server-side against the catalogue, as ids for the
     * client to resolve through `shared/sauces.ts` — never a label echoed off
     * the wire. Null when they picked none. This is the practical half of the
     * feature: one of you is about to be standing at the counter.
     */
    sauces: SauceSelection | null
  }
  /**
   * The code your buddy has to read off you at the handoff — sent to the
   * orderer only, and null for the receiver, who is the one who has to go and
   * read it.
   *
   * Also null for the orderer while the match is being charged: money comes
   * first, and a code released before both halves clear would buy a box nobody
   * paid for. It arrives on `payment_cleared` instead. Non-null here only when
   * no money is in play at all — a demo pairing, or a server explicitly running
   * uncharged.
   */
  pickupCode: string | null
}

/**
 * Pay your half. Sent immediately after `matched`, to each buddy separately.
 *
 * `amountCents` is that buyer's own `share.payCents` copied verbatim — the client
 * never recomputes a price, and the same number is what was sent to Stripe as the
 * PaymentIntent amount.
 */
export interface PaymentRequiredMessage {
  type: 'payment_required'
  matchId: string
  amountCents: number
  /** Stripe PaymentIntent client secret, confirmed in the browser. */
  clientSecret: string
}

/**
 * Both halves cleared, so the handoff can begin.
 *
 * This is where the orderer finally learns their pickup code. It is the same
 * random code the match was struck with — never derived from the match id — and
 * it is still `null` for the receiver, who has to go and read it off the orderer.
 * Payment gates *when* the code is released; it never changes *who* gets it.
 */
export interface PaymentClearedMessage {
  type: 'payment_cleared'
  matchId: string
  pickupCode: string | null
}

/** Which side of the pair failed to pay. */
export type PaymentFailureSide = 'you' | 'buddy'

/**
 * A half went unpaid, so the whole match is off. If this buyer had already paid,
 * that charge has been refunded.
 *
 * The buyer whose payment failed drops out of the queue entirely and has to join
 * again deliberately; the one who paid is requeued. Requeueing both would pair
 * them with each other again on the spot and charge the same card again.
 */
export interface PaymentFailedMessage {
  type: 'payment_failed'
  matchId: string
  whose: PaymentFailureSide
  refunded: boolean
  /** What was handed back to you, in cents. Zero when you were the one who failed. */
  refundedCents: number
}

/** Your buddy disconnected before pickup; you are returned to the queue. */
export interface BuddyLeftMessage {
  type: 'buddy_left'
  matchId: string
}

/** One side of the handoff is in. Sent to both buddies, so both see progress. */
export interface PickupConfirmedMessage {
  type: 'pickup_confirmed'
  matchId: string
  by: BuyerRole
  /** The side still owing a confirmation, or null once both are in. */
  waitingOn: BuyerRole | null
  /** When a still-half-confirmed handoff becomes a dispute; null once both are in. */
  disputeAt: number | null
}

/** Both sides confirmed. The split is settled and written to the ledger. */
export interface PickupCompleteMessage {
  type: 'pickup_complete'
  matchId: string
  settledAt: number
}

/**
 * One side confirmed and the other never did. Nothing settles: a split with a
 * no-show is a case for a human, not a completed match.
 */
export interface PickupDisputedMessage {
  type: 'pickup_disputed'
  matchId: string
  /** The side that did confirm. */
  confirmedBy: BuyerRole | null
  reason: 'timeout' | 'buddy_left'
}

/** You have gone quiet and are about to lose your place. A ping keeps it. */
export interface QueueExpiringMessage {
  type: 'queue_expiring'
  /** Epoch millis your entry is dropped unless the server hears from you. */
  expiresAt: number
}

/** You were dropped from the queue, and why. You are no longer waiting. */
export interface QueueExpiredMessage {
  type: 'queue_expired'
  reason: 'idle'
  /** The idle window you exceeded, so the client can say so in real units. */
  idleMs: number
}

/**
 * Neither side confirmed the match in time, so it is off.
 *
 * Distinct from `pickup_disputed`: this is the case where *nobody* turned up,
 * so there is no claim to adjudicate. The moment one side confirms, the match
 * leaves this timer and a one-sided no-show becomes a dispute instead.
 */
export interface MatchExpiredMessage {
  type: 'match_expired'
  matchId: string
  reason: 'unconfirmed'
  /**
   * Cents returned to you. Always zero while no money is captured before
   * pickup; the field is here so a cancellation can never be reported without
   * saying what happened to the payment.
   */
  refundedCents: number
}

export interface PongMessage {
  type: 'pong'
  at: number
}

export type ProtocolErrorCode =
  | 'bad_message'
  | 'unknown_deal'
  | 'already_waiting'
  | 'already_matched'
  | 'not_waiting'
  | 'not_matched'
  | 'unknown_sauce'
  | 'bad_pickup_code'
  | 'already_confirmed'
  | 'match_disputed'
  /** The pool cannot charge for a match and so will not make one. Fails closed. */
  | 'payment_unavailable'
  /** Both halves have not cleared yet, so there is nothing to confirm. */
  | 'payment_pending'

export interface ErrorMessage {
  type: 'error'
  code: ProtocolErrorCode
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | WaitingMessage
  | MatchedMessage
  | PaymentRequiredMessage
  | PaymentClearedMessage
  | PaymentFailedMessage
  | BuddyLeftMessage
  | PickupConfirmedMessage
  | PickupCompleteMessage
  | PickupDisputedMessage
  | QueueExpiringMessage
  | QueueExpiredMessage
  | MatchExpiredMessage
  | PongMessage
  | ErrorMessage

/**
 * Narrow an untrusted socket payload to a ClientMessage.
 *
 * Anything arriving on a WebSocket is attacker-controlled, so this validates
 * shape and ranges rather than trusting a cast.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>

  switch (msg.type) {
    case 'join': {
      // Any `name` on the wire is ignored, not rejected: the authenticated name
      // is the only one the server will ever show a buddy.
      const { dealId, lat, lng } = msg
      if (typeof dealId !== 'string' || dealId.length === 0 || dealId.length > 64) return null
      const sauces = parseSauceShape(msg.sauces)
      if (sauces === undefined) return null
      // No coordinates is the normal case: the server already resolved a location
      // for this socket. Half a pair is neither a location nor a valid message.
      if (lat === undefined && lng === undefined)
        return withSauces({ type: 'join', dealId }, sauces)
      if (typeof lat !== 'number' || typeof lng !== 'number') return null
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null
      return withSauces({ type: 'join', dealId, lat, lng }, sauces)
    }
    case 'cancel':
      return { type: 'cancel' }
    case 'confirm_pickup': {
      // A missing code is a valid message, not a malformed one: it is what the
      // orderer sends when they tap. The server rejects it for a receiver.
      const { code } = msg
      if (code === undefined || code === null) return { type: 'confirm_pickup', code: null }
      if (typeof code !== 'string' || code.length > 64) return null
      const normalized = normalizePickupCode(code)
      return { type: 'confirm_pickup', code: normalized.length === 0 ? null : normalized }
    }
    case 'ping':
      return { type: 'ping', at: typeof msg.at === 'number' ? msg.at : Date.now() }
    default:
      return null
  }
}

/**
 * Shape-check a `sauces` field: absent, or two strings within a sane bound.
 *
 * Three answers rather than two. `null` is "the field was not there", a pair is
 * "two strings arrived", and `undefined` is "this frame is malformed" — which is
 * not the same as "those are not real sauces", the question `worker/pool.ts`
 * asks the catalogue afterwards.
 */
function parseSauceShape(raw: unknown): readonly [string, string] | null | undefined {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.length !== SAUCES_PER_SELECTION) return undefined
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) return undefined
  }
  return [raw[0], raw[1]]
}

/** Attach a shape-checked selection, leaving the field off when there was none. */
function withSauces(message: JoinMessage, sauces: readonly [string, string] | null): JoinMessage {
  return sauces === null ? message : { ...message, sauces }
}

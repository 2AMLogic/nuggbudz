import type { BuyerRole, BuyerShare, Settlement } from './economics'
import type { LocationSource } from './location'
import { normalizePickupCode } from './pickup'

/** Wire protocol version. Bump on any breaking message change. */
export const PROTOCOL_VERSION = 4

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
}

export interface CancelMessage {
  type: 'cancel'
}

/** Keeps the socket warm and lets the client measure round-trip latency. */
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
  }
  /**
   * The code your buddy has to read off you at the handoff — sent to the
   * orderer only, and null for the receiver, who is the one who has to go and
   * read it.
   */
  pickupCode: string | null
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
  | 'bad_pickup_code'
  | 'already_confirmed'
  | 'match_disputed'

export interface ErrorMessage {
  type: 'error'
  code: ProtocolErrorCode
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | WaitingMessage
  | MatchedMessage
  | BuddyLeftMessage
  | PickupConfirmedMessage
  | PickupCompleteMessage
  | PickupDisputedMessage
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
      // No coordinates is the normal case: the server already resolved a location
      // for this socket. Half a pair is neither a location nor a valid message.
      if (lat === undefined && lng === undefined) return { type: 'join', dealId }
      if (typeof lat !== 'number' || typeof lng !== 'number') return null
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null
      return { type: 'join', dealId, lat, lng }
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

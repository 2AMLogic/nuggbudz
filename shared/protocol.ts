import type { BuyerRole, BuyerShare, Settlement } from './economics'

/** Wire protocol version. Bump on any breaking message change. */
export const PROTOCOL_VERSION = 2

/**
 * Take a seat in the pool.
 *
 * There is deliberately no `name` here: the display name comes from the session
 * the socket was upgraded with, so a buyer cannot present themselves to a buddy
 * as somebody else.
 */
export interface JoinMessage {
  type: 'join'
  dealId: string
  lat: number
  lng: number
}

export interface CancelMessage {
  type: 'cancel'
}

/** Keeps the socket warm and lets the client measure round-trip latency. */
export interface PingMessage {
  type: 'ping'
  at: number
}

export type ClientMessage = JoinMessage | CancelMessage | PingMessage

export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  /** Geohash cell this connection was routed to. */
  cell: string
  waiting: number
  /** Who the server thinks you are, straight off your session. */
  user: {
    id: string
    name: string
  }
}

export interface WaitingMessage {
  type: 'waiting'
  /** How many buyers are queued in this cell, including you. */
  waiting: number
  /** How many eligible buyers joined before you. */
  queuedAhead: number
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
}

/** Your buddy disconnected before pickup; you are returned to the queue. */
export interface BuddyLeftMessage {
  type: 'buddy_left'
  matchId: string
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
      if (typeof lat !== 'number' || typeof lng !== 'number') return null
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null
      return { type: 'join', dealId, lat, lng }
    }
    case 'cancel':
      return { type: 'cancel' }
    case 'ping':
      return { type: 'ping', at: typeof msg.at === 'number' ? msg.at : Date.now() }
    default:
      return null
  }
}

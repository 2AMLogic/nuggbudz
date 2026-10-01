import { CHAT_FRAME_LIMIT, type ChatErrorCode } from './chat'
import type { BuyerRole, BuyerShare, Settlement } from './economics'
import type { ExpiryWindows } from './expiry'
import type { LatLng } from './geo'
import type { LocationSource } from './location'
import { normalizePickupCode } from './pickup'
import type { StandingBand } from './reputation'
import { SAUCES_PER_SELECTION, type SauceSelection } from './sauces'

/** Every message `type` this wire carries, in either direction. */
export type ProtocolMessageType = ClientMessage['type'] | ServerMessage['type']

/** What one wire version changed, and why a client from the one before it cannot cope. */
export interface ProtocolVersionNote {
  readonly version: number
  /** Why a client speaking the previous version cannot be assumed to speak this one. */
  readonly summary: string
  /** Message types this version introduced. */
  readonly added: readonly ProtocolMessageType[]
  /** Message types whose shape or meaning changed under an unchanged `type`. */
  readonly changed: readonly ProtocolMessageType[]
  /**
   * Message types this version withdrew. Plain strings rather than
   * `ProtocolMessageType`, because a withdrawn type is by definition no longer in
   * the union: the name has to outlive the type it refers to.
   */
  readonly removed?: readonly string[]
}

/**
 * Every version of this wire, oldest first, and what each one changed.
 *
 * **A bump is an appended entry here, never an edited number.** `PROTOCOL_VERSION`
 * below is derived from the last entry, so there is no literal to retype — and
 * that is the whole reason for the shape. Twice in one night two branches
 * independently claimed the same number for incompatible message sets (chat and
 * money both wrote `5`; money's merge and the radius work both wrote `6`), and
 * `git` reported no conflict either time, because two sides writing the *same
 * literal* merge cleanly by construction. `vitest`, `tsc` and `biome` were all
 * happy: one integer everybody agrees on is exactly what they are checking for.
 * Appending cannot merge silently — two branches put a different line in the same
 * place, which is a conflict a human has to resolve — and the list is also the
 * answer to "what changed in version N", which both collisions could only be
 * diagnosed by reconstructing from two diffs. `test/protocol-merge.test.ts`
 * demonstrates both halves of that on a throwaway clone rather than asserting it.
 *
 * Append at the bottom, numbered one past the current last. Never renumber a
 * landed entry, and never reach for a literal instead.
 *
 * Entries before 5 were reconstructed from `git log` when this list was
 * introduced (issue #91), so the `added` sets are mechanical but the summaries are
 * not contemporaneous notes. Two of those versions are the same defect this shape
 * closes, visible only now that the history is written down: three unrelated
 * changes each reached 4 separately, and the expiry messages arrived under 3 with
 * no bump at all.
 */
export const PROTOCOL_HISTORY: readonly [ProtocolVersionNote, ...ProtocolVersionNote[]] = [
  {
    version: 1,
    summary: 'The first wire: join a pool, wait, be paired with one buddy, cancel or be left.',
    added: [
      'join',
      'cancel',
      'ping',
      'welcome',
      'waiting',
      'matched',
      'buddy_left',
      'pong',
      'error',
    ],
    changed: [],
  },
  {
    version: 2,
    summary:
      'Identity moved to the session: `join` lost its `name` — one on the wire is now ignored — and `welcome` carries the authenticated `user` instead.',
    added: [],
    changed: ['join', 'welcome'],
  },
  {
    version: 3,
    summary:
      'Two-sided pickup confirmation, so a split settles only when both buddies confirm the handoff — and, under the same number rather than a bump of its own, the liveness sweep that drops a stale queue entry or an unconfirmed match.',
    added: [
      'confirm_pickup',
      'pickup_confirmed',
      'pickup_complete',
      'pickup_disputed',
      'queue_expiring',
      'queue_expired',
      'match_expired',
    ],
    changed: [],
  },
  {
    version: 4,
    summary:
      'Three changes reached this number separately: `join` coordinates became optional because the server resolves a location itself, `welcome` gained `locationSource` so a buyer on the demo origin is never told it is where they are, and a sauce pair rides out on `join` and back on `matched`.',
    added: [],
    changed: ['join', 'welcome', 'matched'],
  },
  {
    version: 5,
    summary:
      'Nuggchat: a two-party relay between matched buddies, stored nowhere, and with it the chat arm of `ProtocolErrorCode` that routes a refusal to the right control on screen.',
    added: ['chat', 'chat_message'],
    changed: ['error'],
  },
  {
    version: 6,
    summary:
      'Money in front of the pickup code: `matched` no longer carries one while a match is being charged and it arrives on `payment_cleared` instead, and every teardown now says what became of the charge — `heldCents` is money collected and *not* handed back, which an older client would show as nothing at all.',
    added: ['payment_required', 'payment_cleared', 'payment_failed'],
    changed: ['matched', 'error', 'match_expired', 'pickup_disputed'],
  },
  {
    version: 7,
    summary:
      'The market became a distance rather than a shard: `welcome` carries `position` and `radiusMeters`, without which a client has no centre for its map and no idea how far "nearby" is, and `waiting` counts and the `buddies` roster are scoped to that radius rather than to the shard — the same fields meaning something else.',
    added: [],
    changed: ['welcome', 'waiting'],
  },
  {
    version: 8,
    summary:
      '`matched.buddy` gained `standing`, a band derived from past handoffs, so a client can render how a buddy has shown up before without seeing a count it could turn into a score.',
    added: [],
    changed: ['matched'],
  },
  {
    version: 9,
    summary:
      '`buddy_left` gained `heldCents`, closing the one teardown frame that carried no money fields — the abandonment path always refunds, but a refund is only a refund once Stripe confirms it, and until now a survivor whose refund was refused was told nothing about it.',
    added: [],
    changed: ['buddy_left'],
  },
  {
    version: 10,
    summary:
      'Sign-in moved from the socket to the seat (#150): an unauthenticated upgrade is welcomed under an anonymous identity instead of refused, a socket without a seat is sent `market` counts (never the `buddies` roster), and `join` from an identity that may not take a seat is refused with `sign_in_required` — which an older client would read as a generic error rather than as the prompt to sign in.',
    added: ['market'],
    changed: ['welcome', 'error'],
  },
]

/**
 * Wire protocol version — the newest entry above, never a literal.
 *
 * Bump on any breaking message change, by appending to `PROTOCOL_HISTORY`.
 */
export const PROTOCOL_VERSION = PROTOCOL_HISTORY[PROTOCOL_HISTORY.length - 1].version

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
 * walking distance; it can never change the shard, which was fixed when the
 * socket was upgraded.
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

/**
 * Say something to the buddy you are matched with.
 *
 * There is no `matchId` and no `from` here, and both omissions are deliberate.
 * The match and the sender are read off the connection's server-side state, so a
 * caller cannot address a match they are not in or speak as somebody else — the
 * same rule that keeps `name` off `join`.
 *
 * `text` is raw, attacker-chosen input. It is sanitized on the server before it
 * reaches anyone, never here and never on the sending client.
 */
export interface ChatSendMessage {
  type: 'chat'
  text: string
}

export type ClientMessage =
  | JoinMessage
  | CancelMessage
  | PingMessage
  | ConfirmPickupMessage
  | ChatSendMessage

export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  /**
   * Geohash cell (shard) this connection was routed to — the shard, not the market.
   * Nothing on screen shows it: matching is decided by `radiusMeters` below, and
   * the shard id is only here so a test (and a ledger row) can say which Durable
   * Object handled a socket.
   */
  cell: string
  /**
   * The position the server actually placed this socket at.
   *
   * Sending a buyer their own position is not a disclosure — it is theirs
   * already, and on the opt-in rung they supplied it. It is here because the map
   * needs a centre on *every* rung: the server always knows where it put a
   * socket, and hiding the map whenever the buyer declined a permission prompt
   * withheld a picture we could always have drawn. Everyone *else* stays snapped
   * through `snapToGrid` — see `RadiusBuddy`.
   */
  position: LatLng
  /**
   * Which rung of the location fallback produced that position. The client shows
   * this: a buyer on the demo origin should never be told it is where they are.
   */
  locationSource: LocationSource
  /**
   * How far a buddy may be and still be matched with this buyer, in metres.
   *
   * The market is this circle, not the shard. Sent so no client carries its own
   * idea of how far "nearby" is — the same reason deal prices are data rather
   * than literals. Metres because metres are canonical everywhere in code; the
   * screen converts once, in `formatMiles`.
   */
  radiusMeters: number
  waiting: number
  /**
   * Who the server thinks you are: straight off your session, or — since #150 —
   * the anonymous `demo:` identity a signed-out browser is welcomed under. An
   * anonymous socket is shown the market like any other; whether it may take a
   * seat is decided when it asks for one (`sign_in_required`), not here.
   */
  user: {
    id: string
    name: string
  }
  /**
   * The liveness windows this shard enforces. Sent so a client knows how often it
   * has to ping to keep its seat, rather than hardcoding a guess at the server's
   * policy.
   */
  expiry: ExpiryWindows
  /**
   * How long a half-confirmed handoff sits before it becomes a dispute — see
   * `PickupConfirmedMessage.disputeAt`. Sent for the same reason `expiry` is:
   * so a client (this repo's smoke test included) can tell a correct deadline
   * from a broken one without hardcoding a guess at the server's policy.
   */
  pickupTimeoutMs: number
}

/**
 * Another buyer waiting within your radius, reduced to a dot on a map.
 *
 * Deliberately just coordinates: no `connId`, no `name`. The position itself
 * is already coarse by the time it reaches here — see `snapToGrid` in
 * `shared/geo.ts` — so an unmatched buyer is anonymous and only approximately
 * located, never identifiable and never exact.
 */
export interface RadiusBuddy {
  lat: number
  lng: number
}

export interface WaitingMessage {
  type: 'waiting'
  /**
   * How many buyers on your deal are queued within your radius, including you.
   *
   * Radius-scoped, not shard-scoped. The shard is a region — a count of
   * everybody in it would be a number about infrastructure, and the buyer is
   * asking how many people could actually meet them.
   */
  waiting: number
  /** How many of those eligible buyers joined before you. */
  queuedAhead: number
  /**
   * Everyone else waiting within your radius, on any deal, snapped to a coarse
   * grid — never you. Any deal, because the map is explaining the market rather
   * than the queue; within the radius, because a dot you could never be matched
   * with is noise on the screen and a privacy surface off it.
   */
  buddies: RadiusBuddy[]
}

/**
 * The market around a socket that holds no seat — counts, and nothing else.
 *
 * Sent to every idle socket, signed in or not, whenever the queue near it
 * changes, and once straight after `welcome`. This is what a signed-out visitor
 * sees before being asked for an account: how many people are waiting within
 * their radius right now, which is the product's whole argument.
 *
 * Deliberately **no roster**. `buddies` — even as snapped, nameless dots — goes
 * only to a socket that took a seat, on `waiting`. A browse-only socket can be
 * opened by anybody without an account, so handing it the dots would make
 * "where are the people near me" free to scrape, and signing in would stop
 * being what earns the sight of them.
 */
export interface MarketMessage {
  type: 'market'
  /** Buyers queued within your radius, on any deal. */
  waiting: number
  /**
   * The same count split by deal id. Nobody here holds a seat, so this is also
   * exactly how many would be queued ahead of you if you took one on that deal
   * now — the browse-only answer to `WaitingMessage.queuedAhead`. A deal with
   * nobody waiting is absent rather than zero.
   */
  byDeal: Record<string, number>
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
    /**
     * How this buddy's past handoffs have gone, as a band and never as counts.
     *
     * Derived on the server from `user_reputation` and sent as one of three
     * values, so there is nothing here a buyer could be shamed with and nothing
     * a client could compute a miss rate from. The client resolves it through
     * `describeStanding` rather than printing it, the same division `sauces`
     * follows.
     */
    standing: StandingBand
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
 * that charge has been refunded — or, if the processor refused the refund, is
 * being held for a human, which is said out loud rather than papered over.
 *
 * The buyer whose payment failed drops out of the queue entirely and has to join
 * again deliberately; the one who paid is requeued. Requeueing both would pair
 * them with each other again on the spot and charge the same card again.
 */
export interface PaymentFailedMessage {
  type: 'payment_failed'
  matchId: string
  whose: PaymentFailureSide
  /** True only of a refund the processor confirmed. Never of one merely attempted. */
  refunded: boolean
  /** What was handed back to you, in cents. Zero when you were the one who failed. */
  refundedCents: number
  /**
   * Collected from you and *not* handed back, in cents — a refund the processor
   * refused. Zero in the ordinary case. A buyer with cents here has not been
   * refunded and is not told they have been: the money is held against the
   * server's record until a human reconciles it.
   */
  heldCents: number
}

/** Your buddy disconnected before pickup; you are returned to the queue. */
export interface BuddyLeftMessage {
  type: 'buddy_left'
  matchId: string
  /**
   * What you paid and is being held, in cents — a refund the processor refused.
   * Zero in the ordinary case, where the refund cleared.
   *
   * The abandonment teardown always refunds, unlike a dispute — but a refund is
   * only a refund once Stripe confirms it, and a per-intent refund can be
   * refused independently of the other leg. This is the same distinction
   * `PaymentFailedMessage`/`MatchExpiredMessage`/`PickupDisputedMessage` already
   * make: a buyer with cents here has not been refunded and is not told they
   * have been.
   */
  heldCents: number
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
  /**
   * What you paid and is being held, in cents, pending a human.
   *
   * A dispute deliberately does not refund — see README's "A disputed split
   * holds the money" — so this is the one teardown that can report held cents
   * with nothing having gone wrong at the processor.
   */
  heldCents: number
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
   * Cents returned to you, and confirmed by the processor. The field is here so a
   * cancellation can never be reported without saying what happened to the
   * payment.
   */
  refundedCents: number
  /** Cents collected from you that the processor would not hand back. */
  heldCents: number
}

/**
 * One line of a two-party conversation, relayed live.
 *
 * Sent to both buddies and to nobody else — not to another buyer queued in the
 * same market, not to another match in the same shard. The sender gets it back so
 * both screens render the same canonical, sanitized text rather than the sender
 * seeing what they typed and the buddy seeing what survived cleaning.
 *
 * **Never stored.** There is no history to fetch on reconnect, and that is the
 * feature: a buddy who reloads has lost the conversation, exactly as the screen
 * promises. If this message cannot be handed to a live socket it is refused to
 * the sender, never queued.
 */
export interface ChatRelayMessage {
  type: 'chat_message'
  matchId: string
  /** Which side of the match said it, taken from their connection. */
  from: BuyerRole
  /** The sender's session display name — never a name off the wire. */
  name: string
  /** Sanitized text, byte for byte what the other buddy is shown. */
  text: string
  at: number
}

export interface PongMessage {
  type: 'pong'
  at: number
}

/**
 * Everything the server will refuse a request with.
 *
 * The chat half comes from `CHAT_ERROR_CODES` rather than being spelled out
 * again, because that list is also what routes a refusal to the right control on
 * the matched screen. Adding a chat code in one place only is not possible.
 */
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
  /**
   * This identity may browse but not take a seat: an anonymous browser on a
   * deployment where `ALLOW_DEMO_PAIRING` is off. The client's cue to show the
   * sign-in interstitial — see `seatVerdict` in `shared/identity.ts`.
   */
  | 'sign_in_required'
  | ChatErrorCode

export interface ErrorMessage {
  type: 'error'
  code: ProtocolErrorCode
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | WaitingMessage
  | MarketMessage
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
  | ChatRelayMessage
  | PongMessage
  | ErrorMessage

/**
 * Every message type on the wire, as data rather than only as a type.
 *
 * Keyed by the union so the two cannot drift apart: a message added to
 * `ClientMessage` or `ServerMessage` without a key here fails to compile, and a
 * key naming a message that does not exist fails too. It is data because
 * `PROTOCOL_HISTORY` claims which types each version introduced, and a claim about
 * the message set is only worth making if something can check it against the
 * actual message set — see `test/protocol.test.ts`.
 */
const MESSAGE_TYPE_KEYS: Record<ProtocolMessageType, true> = {
  join: true,
  cancel: true,
  ping: true,
  confirm_pickup: true,
  chat: true,
  welcome: true,
  waiting: true,
  market: true,
  matched: true,
  payment_required: true,
  payment_cleared: true,
  payment_failed: true,
  buddy_left: true,
  pickup_confirmed: true,
  pickup_complete: true,
  pickup_disputed: true,
  queue_expiring: true,
  queue_expired: true,
  match_expired: true,
  chat_message: true,
  pong: true,
  error: true,
}

/** The keys above, as a list. The cast is `Object.keys` losing the key type. */
export const PROTOCOL_MESSAGE_TYPES = Object.keys(
  MESSAGE_TYPE_KEYS,
) as readonly ProtocolMessageType[]

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
    case 'chat': {
      // Any `matchId` or `from` on the wire is ignored, not rejected, for the
      // same reason `join` ignores `name`: the connection already says who is
      // talking and which match they are in.
      const { text } = msg
      if (typeof text !== 'string') return null
      // The structural bound only. Whether the *content* is acceptable — empty
      // after sanitizing, or over the policy cap — is a decision the server
      // answers with a specific error code, not something to collapse into
      // `bad_message` here.
      if (text.length > CHAT_FRAME_LIMIT) return null
      return { type: 'chat', text }
    }
    case 'ping':
      return { type: 'ping', at: typeof msg.at === 'number' ? msg.at : Date.now() }
    default:
      // An unknown type — a newer client talking to an older server, or a probe.
      // Null, so the caller answers `bad_message` and the socket stays up.
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

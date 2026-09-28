import { DurableObject } from 'cloudflare:workers'
import { CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS, reviewChatText } from '../shared/chat'
import { findDeal, isDealOffered } from '../shared/deals'
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
import { type LatLng, snapToGrid } from '../shared/geo'
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
import { type Env, intVar } from './env'
import { writeSettledMatch } from './ledger'

/**
 * Who is on the other end of a socket.
 *
 * Identity and cell are both set by the Worker at upgrade time and never from a
 * client message, so a connection cannot rename itself or move market.
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
  private get radiusMeters(): number {
    return intVar(this.env.MATCH_RADIUS_METERS, 800)
  }

  private get pickupTimeoutMs(): number {
    return intVar(this.env.PICKUP_CONFIRM_TIMEOUT_MS, DEFAULT_PICKUP_TIMEOUT_MS)
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

  override async fetch(request: Request): Promise<Response> {
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
      locationSource,
      waiting: this.waitingStates().length,
      user: { id: userId, name },
      expiry: this.windows,
    })

    return new Response(null, { status: 101, webSocket: client })
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

    const now = Date.now()
    // Same sliding window the upgrade limiter uses (#10), per connection rather
    // than per IP, because the thing being limited here is one seat in one match.
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
   */
  override async alarm(): Promise<void> {
    const now = Date.now()
    for (const record of (await this.matchRecords()).values()) {
      if (record.status !== 'pending') continue
      if (!isPickupDisputed(record.confirmations, now, this.pickupTimeoutMs)) continue
      await this.disputeMatch(record, now, 'timeout')
    }

    await this.sweepExpired(now)
    await this.scheduleSweep()
  }

  /**
   * Age out whatever has gone stale in this cell: buyers who stopped answering,
   * and matches neither side ever confirmed.
   *
   * One sweep per cell rather than a timer per connection — a Durable Object
   * processes one event at a time, so a single sweep sees the whole market and
   * two timers can never disagree about who is still queued.
   */
  private async sweepExpired(now: number): Promise<void> {
    const windows = this.windows
    const queue = this.waitingStates()
    const plan = planSweep(
      now,
      queue.map(({ state }) => livenessOf(state)),
      expirableMatches((await this.matchRecords()).values()),
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

    for (const matchId of plan.cancel) await this.cancelMatch(matchId)

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
    for (const peer of this.matchSockets(matchId)) {
      this.setState(peer.ws, principalOf(peer.state))
      this.send(peer.ws, {
        type: 'match_expired',
        matchId,
        reason: 'unconfirmed',
        // Nothing is captured before pickup, so there is nothing to give back.
        refundedCents: 0,
      })
    }
    await this.ctx.storage.delete(`match:${matchId}`)
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
    }
    // A second tab is not a second buyer: never pair an account with itself.
    const others = this.waitingStates().filter((o) => o.state.userId !== identity.userId)
    const decision = findMatch(
      toCandidate(identity),
      others.map((o) => toCandidate(o.state)),
      this.radiusMeters,
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
    })

    const shareFor = (role: BuyerRole) =>
      role === 'orderer' ? settlement.shares[0] : settlement.shares[1]
    // Only the orderer is told the code. The receiver has to go and read it off
    // them, which is the entire proof that the two of them met.
    const codeFor = (role: BuyerRole) => (role === 'orderer' ? pickupCode : null)

    this.setState(ws, { ...selfIdentity, status: 'matched', matchId, role: selfRole })
    this.setState(buddy.ws, { ...buddyIdentity, status: 'matched', matchId, role: buddyRole })

    this.send(ws, {
      type: 'matched',
      matchId,
      role: selfRole,
      share: shareFor(selfRole),
      settlement,
      buddy: { name: buddyIdentity.name, distanceMeters: decision.distanceMeters },
      pickupCode: codeFor(selfRole),
    })
    this.send(buddy.ws, {
      type: 'matched',
      matchId,
      role: buddyRole,
      share: shareFor(buddyRole),
      settlement,
      buddy: { name: selfIdentity.name, distanceMeters: decision.distanceMeters },
      pickupCode: codeFor(buddyRole),
    })

    // Two buyers just left the waiting pool: everyone still queued in this
    // cell needs the roster refreshed, or their map would keep showing dots
    // for buddies who are no longer waiting.
    this.broadcastWaiting()
    // The match now has a confirmation deadline of its own.
    await this.scheduleSweep()
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
   * This is the only place a ledger row is written. Anything that has not been
   * confirmed by both sides is live state, and live state belongs to this
   * object rather than to D1.
   */
  private async completeMatch(record: MatchRecord, at: number): Promise<void> {
    record.status = 'complete'
    record.settledAt = at
    await this.ctx.storage.put(`match:${record.matchId}`, record)

    try {
      await writeSettledMatch(this.env.DB, {
        matchId: record.matchId,
        dealId: record.dealId,
        cell: record.cell,
        distanceMeters: record.distanceMeters,
        createdAt: record.createdAt,
        settledAt: at,
        settlement: record.settlement,
        names: { orderer: record.orderer.name, receiver: record.receiver.name },
        // The ledger decides for itself whether this is a real split; a demo
        // pairing settles on screen and books nothing. See `isDemoMatch`.
        userIds: { orderer: record.orderer.userId, receiver: record.receiver.userId },
      })
    } catch (error) {
      // A ledger outage must not strand two people who already swapped nuggets.
      // The completed record stays in storage, which is what a reconciliation
      // pass replays from.
      console.error('ledger write failed', record.matchId, error)
    }

    for (const peer of this.matchSockets(record.matchId)) {
      this.send(peer.ws, { type: 'pickup_complete', matchId: record.matchId, settledAt: at })
      // Free to queue for the next box.
      this.setState(peer.ws, principalOf(peer.state))
    }
    await this.scheduleSweep()
  }

  /**
   * One side confirmed and the other never did.
   *
   * Nothing is written to the ledger: a split where one buddy says the handoff
   * happened and the other says nothing is a case for a human. Callers re-arm
   * the alarm afterwards.
   */
  private async disputeMatch(
    record: MatchRecord,
    at: number,
    reason: 'timeout' | 'buddy_left',
    except?: WebSocket,
  ): Promise<void> {
    record.status = 'disputed'
    record.disputedAt = at
    await this.ctx.storage.put(`match:${record.matchId}`, record)

    const confirmedBy = confirmedRole(record.confirmations)
    for (const peer of this.matchSockets(record.matchId, except)) {
      this.send(peer.ws, {
        type: 'pickup_disputed',
        matchId: record.matchId,
        confirmedBy,
        reason,
      })
      this.setState(peer.ws, principalOf(peer.state))
    }
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
      this.send(other.ws, { type: 'buddy_left', matchId: state.matchId })
    }

    await this.ctx.storage.delete(`match:${state.matchId}`)
    // Without this the survivor's UI would keep showing the pool count (and
    // buddy dots) from before they were matched, which for an instant match
    // is zero — and it also tells everyone else in the cell about the
    // buyer who just got requeued.
    this.broadcastWaiting()
    // The requeued buddy is back under the queue's idle timer, and the match's
    // own deadline is gone with the record.
    await this.scheduleSweep()
  }

  /**
   * Tell a queued buyer where they stand. Called after the state is committed,
   * so the count includes the buyer being told.
   */
  private sendWaiting(ws: WebSocket, state: WaitingState): void {
    const eligible = this.waitingStates().filter((o) => o.state.dealId === state.dealId)
    // The map roster is the whole cell, not just this buyer's deal: a cell can
    // host more than one deal's queue at once, and the point of the map is to
    // explain the cell as a market, not to leak who could actually pair.
    const buddies = this.waitingStates()
      .filter((o) => o.state.connId !== state.connId)
      // Quantized here, at the one chokepoint every waiting broadcast passes
      // through, so a buyer's exact position never reaches the wire.
      .map((o) => snapToGrid(o.state))

    this.send(ws, {
      type: 'waiting',
      waiting: eligible.length,
      queuedAhead: eligible.filter(
        (o) => o.state.connId !== state.connId && o.state.joinedAt < state.joinedAt,
      ).length,
      buddies,
    })
  }

  private async matchRecords(): Promise<Map<string, MatchRecord>> {
    return await this.ctx.storage.list<MatchRecord>({ prefix: 'match:' })
  }

  /**
   * Re-arm the cell's single alarm at the earliest of everything outstanding —
   * and delete it when nothing is, so a cell nobody is using is never woken to
   * do nothing.
   *
   * The two match deadlines are computed from disjoint sets and that is what
   * keeps them from competing: `disputeDeadline` is null until somebody
   * confirms, and `expirableMatches` drops a match the moment somebody does.
   */
  private async scheduleSweep(): Promise<void> {
    const now = Date.now()
    const records = [...(await this.matchRecords()).values()]

    let next: number | null = null
    const dueAt = (at: number | null) => {
      if (at === null) return
      if (next === null || at < next) next = at
    }

    for (const record of records) {
      if (record.status !== 'pending') continue
      dueAt(disputeDeadline(record.confirmations, this.pickupTimeoutMs))
    }

    const plan = planSweep(
      now,
      this.waitingStates().map(({ state }) => livenessOf(state)),
      expirableMatches(records),
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

  /** Refresh every waiting socket's roster after a join, cancel or disconnect. */
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
  return { connId, userId, name, cell, origin, locationSource, dealId, lat, lng, joinedAt }
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

function toCandidate(identity: BuyerIdentity): Candidate {
  return {
    id: identity.connId,
    dealId: identity.dealId,
    lat: identity.lat,
    lng: identity.lng,
    joinedAt: identity.joinedAt,
  }
}

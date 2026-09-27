import { DurableObject } from 'cloudflare:workers'
import { findDeal } from '../shared/deals'
import type { BuyerRole, Settlement } from '../shared/economics'
import { settle } from '../shared/economics'
import type { LatLng } from '../shared/geo'
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
  | ({ status: 'waiting' } & BuyerIdentity)
  | ({ status: 'matched'; matchId: string; role: BuyerRole } & BuyerIdentity)

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
        this.send(ws, { type: 'pong', at: msg.at })
        return
      case 'cancel':
        this.handleCancel(ws)
        return
      case 'confirm_pickup':
        await this.handleConfirmPickup(ws, msg.code)
        return
      case 'join':
        await this.handleJoin(ws, msg)
        return
    }
  }

  /**
   * The timeout on a one-sided confirmation.
   *
   * Only ever set from the earliest live deadline, and re-armed after each
   * sweep, because a Durable Object has exactly one alarm to share.
   */
  override async alarm(): Promise<void> {
    const now = Date.now()
    for (const record of (await this.matchRecords()).values()) {
      if (record.status !== 'pending') continue
      if (!isPickupDisputed(record.confirmations, now, this.pickupTimeoutMs)) continue
      await this.disputeMatch(record, now, 'timeout')
    }
    await this.rescheduleDisputeAlarm()
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

    const deal = findDeal(dealId)
    if (deal === undefined) {
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
      const waiting: WaitingState = { ...identity, status: 'waiting' }
      this.setState(ws, waiting)
      this.sendWaiting(ws, waiting)
      return
    }

    // The buddy is whichever of the pair is not this connection.
    const buddyConnId =
      decision.orderer.id === identity.connId ? decision.receiver.id : decision.orderer.id
    const buddy = others.find((o) => o.state.connId === buddyConnId)
    if (buddy === undefined) {
      // Buddy vanished between the scan and here. Queue instead of pairing with a ghost.
      const waiting: WaitingState = { ...identity, status: 'waiting' }
      this.setState(ws, waiting)
      this.sendWaiting(ws, waiting)
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
    await this.rescheduleDisputeAlarm()
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
    await this.rescheduleDisputeAlarm()
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

  private handleCancel(ws: WebSocket): void {
    const state = this.getState(ws)
    if (state === null) return
    if (state.status !== 'waiting') {
      this.fail(ws, 'not_waiting', 'nothing to cancel')
      return
    }
    this.setState(ws, principalOf(state))
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
    if (state === null || state.status !== 'matched') return

    const record = await this.ctx.storage.get<MatchRecord>(`match:${state.matchId}`)
    if (
      record !== undefined &&
      record.status === 'pending' &&
      confirmedRole(record.confirmations) !== null
    ) {
      await this.disputeMatch(record, Date.now(), 'buddy_left', ws)
      await this.rescheduleDisputeAlarm()
      return
    }

    for (const other of this.states()) {
      if (other.ws === ws) continue
      if (other.state.status !== 'matched' || other.state.matchId !== state.matchId) continue

      const requeued: WaitingState = {
        ...identityOf(other.state),
        status: 'waiting',
        // Requeued at the back, so they do not jump buyers who waited honestly.
        joinedAt: Date.now(),
      }
      this.setState(other.ws, requeued)
      this.send(other.ws, { type: 'buddy_left', matchId: state.matchId })
      // Without this the survivor's UI would keep showing the pool count from
      // before they were matched, which for an instant match is zero.
      this.sendWaiting(other.ws, requeued)
    }

    await this.ctx.storage.delete(`match:${state.matchId}`)
  }

  /**
   * Tell a queued buyer where they stand. Called after the state is committed,
   * so the count includes the buyer being told.
   */
  private sendWaiting(ws: WebSocket, state: WaitingState): void {
    const eligible = this.waitingStates().filter((o) => o.state.dealId === state.dealId)
    this.send(ws, {
      type: 'waiting',
      waiting: eligible.length,
      queuedAhead: eligible.filter(
        (o) => o.state.connId !== state.connId && o.state.joinedAt < state.joinedAt,
      ).length,
    })
  }

  private async matchRecords(): Promise<Map<string, MatchRecord>> {
    return await this.ctx.storage.list<MatchRecord>({ prefix: 'match:' })
  }

  /**
   * Re-arm the dispute alarm at the earliest live deadline.
   *
   * One alarm per object, so it is always the minimum across every half-confirmed
   * match; the sweep in `alarm()` then handles however many have come due.
   */
  private async rescheduleDisputeAlarm(): Promise<void> {
    let next: number | null = null
    for (const record of (await this.matchRecords()).values()) {
      if (record.status !== 'pending') continue
      const deadline = disputeDeadline(record.confirmations, this.pickupTimeoutMs)
      if (deadline === null) continue
      if (next === null || deadline < next) next = deadline
    }

    const current = await this.ctx.storage.getAlarm()
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
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

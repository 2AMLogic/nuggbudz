import { DurableObject } from 'cloudflare:workers'
import { findDeal } from '../shared/deals'
import type { BuyerRole } from '../shared/economics'
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
import { type Candidate, findMatch } from '../shared/matchmaker'
import {
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol'
import { type Env, intVar } from './env'

/**
 * Who is on the other end of a socket.
 *
 * Both fields are set by the Worker from the caller's session at upgrade time
 * and never from a client message, so a connection cannot rename itself.
 */
interface Principal {
  connId: string
  userId: string
  name: string
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
  | ({ status: 'matched'; matchId: string; role: BuyerRole } & BuyerIdentity)

type WaitingState = Extract<ConnState, { status: 'waiting' }>

interface MatchRecord {
  matchId: string
  dealId: string
  createdAt: number
  ordererConnId: string
  receiverConnId: string
  distanceMeters: number
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

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)

    const connId = crypto.randomUUID()
    this.setState(server, { status: 'idle', connId, userId, name })

    this.send(server, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      cell: params.get('cell') ?? '',
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
      case 'join':
        await this.handleJoin(ws, msg.dealId, msg.lat, msg.lng)
        return
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws)
  }

  private async handleJoin(ws: WebSocket, dealId: string, lat: number, lng: number): Promise<void> {
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

    const identity: BuyerIdentity = {
      connId: state.connId,
      // The authenticated name, not anything the client sent.
      userId: state.userId,
      name: state.name,
      dealId,
      lat,
      lng,
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

    await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, {
      matchId,
      dealId,
      createdAt: Date.now(),
      ordererConnId: decision.orderer.id,
      receiverConnId: decision.receiver.id,
      distanceMeters: decision.distanceMeters,
    })

    const selfRole: BuyerRole = ordererIsSelf ? 'orderer' : 'receiver'
    const buddyRole: BuyerRole = ordererIsSelf ? 'receiver' : 'orderer'
    const shareFor = (role: BuyerRole) =>
      role === 'orderer' ? settlement.shares[0] : settlement.shares[1]

    this.setState(ws, { ...selfIdentity, status: 'matched', matchId, role: selfRole })
    this.setState(buddy.ws, { ...buddyIdentity, status: 'matched', matchId, role: buddyRole })

    this.send(ws, {
      type: 'matched',
      matchId,
      role: selfRole,
      share: shareFor(selfRole),
      settlement,
      buddy: { name: buddyIdentity.name, distanceMeters: decision.distanceMeters },
    })
    this.send(buddy.ws, {
      type: 'matched',
      matchId,
      role: buddyRole,
      share: shareFor(buddyRole),
      settlement,
      buddy: { name: selfIdentity.name, distanceMeters: decision.distanceMeters },
    })

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
    this.sendWaiting(ws, waiting)
    await this.scheduleSweep()
  }

  private async handleCancel(ws: WebSocket): Promise<void> {
    const state = this.getState(ws)
    if (state === null) return
    if (state.status !== 'waiting') {
      this.fail(ws, 'not_waiting', 'nothing to cancel')
      return
    }
    this.setState(ws, idleState(state))
    await this.scheduleSweep()
  }

  /**
   * Treat a ping as a sign of life, which is what keeps a buyer who is sitting
   * on the page from being aged out mid-wait. A buyer who speaks up after being
   * warned is forgiven, so the warning can be sent again later.
   *
   * No rescheduling here on purpose: the standing alarm is always at or before
   * this entry's new deadline, so it fires, finds nothing due, and re-arms.
   */
  private refreshLiveness(ws: WebSocket): void {
    const state = this.getState(ws)
    if (state === null || state.status !== 'waiting') return
    this.setState(ws, { ...state, lastSeenAt: Date.now(), warned: false })
  }

  /**
   * Drop a connection, and if it was half of a match, return the abandoned
   * buddy to the queue rather than leaving them staring at a dead match.
   */
  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const state = this.getState(ws)

    if (state !== null && state.status === 'matched') {
      for (const other of this.states()) {
        if (other.ws === ws) continue
        if (other.state.status !== 'matched' || other.state.matchId !== state.matchId) continue

        const now = Date.now()
        const requeued: WaitingState = {
          ...identityOf(other.state),
          status: 'waiting',
          // Requeued at the back, so they do not jump buyers who waited honestly.
          joinedAt: now,
          lastSeenAt: now,
          warned: false,
        }
        this.setState(other.ws, requeued)
        this.send(other.ws, { type: 'buddy_left', matchId: state.matchId })
        // Without this the survivor's UI would keep showing the pool count from
        // before they were matched, which for an instant match is zero.
        this.sendWaiting(other.ws, requeued)
      }

      await this.ctx.storage.delete(`match:${state.matchId}`)
    }

    // A departure can also mean nothing is pending any more, which is the case
    // where the alarm is dropped rather than re-armed.
    await this.scheduleSweep()
  }

  /**
   * Age out whatever has gone stale in this cell, then re-arm only if something
   * is still pending.
   *
   * One alarm per cell rather than a timer per connection: a Durable Object
   * processes one event at a time, so a single sweep sees the whole market with
   * no risk of two timers disagreeing about who is still in the queue.
   */
  override async alarm(): Promise<void> {
    const now = Date.now()
    const windows = this.windows
    const queue = this.waitingStates()
    const plan = planSweep(
      now,
      queue.map(({ state }) => livenessOf(state)),
      await this.openMatches(),
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
      this.setState(entry.ws, idleState(entry.state))
      // Dropped, and told why: a silent removal looks like the pool losing them.
      this.send(entry.ws, { type: 'queue_expired', reason: 'idle', idleMs: windows.queueIdleMs })
    }

    for (const matchId of plan.cancel) await this.cancelMatch(matchId)

    await this.scheduleSweep()
  }

  /**
   * Point the cell's alarm at the next thing that falls due — and delete it when
   * nothing does, so a cell nobody is using is never woken to do nothing.
   */
  private async scheduleSweep(): Promise<void> {
    const now = Date.now()
    const plan = planSweep(
      now,
      this.waitingStates().map(({ state }) => livenessOf(state)),
      await this.openMatches(),
      this.windows,
    )
    const at = nextAlarmAt(now, plan)
    const current = await this.ctx.storage.getAlarm()

    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    // An alarm that is already earlier is harmless — it fires, finds nothing
    // due, and re-arms from here — so only ever pull the wake-up forward.
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  /**
   * Call off a match nobody confirmed in time.
   *
   * Both halves are told and returned to idle rather than requeued: at least one
   * of them has walked away, and requeueing two connected buyers would just pair
   * them with each other again on the spot.
   */
  private async cancelMatch(matchId: string): Promise<void> {
    for (const { ws, state } of this.states()) {
      if (state.status !== 'matched' || state.matchId !== matchId) continue
      this.setState(ws, idleState(state))
      this.send(ws, {
        type: 'match_expired',
        matchId,
        reason: 'unconfirmed',
        // Nothing is captured before pickup, so there is nothing to give back.
        refundedCents: 0,
      })
    }
    await this.ctx.storage.delete(`match:${matchId}`)
  }

  /** Matches struck but not yet settled, including any whose sockets are gone. */
  private async openMatches(): Promise<OpenMatch[]> {
    const records = await this.ctx.storage.list<MatchRecord>({ prefix: 'match:' })
    return [...records.values()].map(({ matchId, createdAt }) => ({ matchId, createdAt }))
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

/** Release a connection back to holding its identity and nothing else. */
function idleState({ connId, userId, name }: Principal): ConnState {
  return { status: 'idle', connId, userId, name }
}

/** The liveness view of a queue entry, which is all the expiry rule needs. */
function livenessOf(state: WaitingState): QueueEntry {
  return { id: state.connId, lastSeenAt: state.lastSeenAt, warned: state.warned }
}

/** Strip connection status off a state, leaving just who and where the buyer is. */
function identityOf(state: BuyerIdentity): BuyerIdentity {
  const { connId, userId, name, dealId, lat, lng, joinedAt } = state
  return { connId, userId, name, dealId, lat, lng, joinedAt }
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

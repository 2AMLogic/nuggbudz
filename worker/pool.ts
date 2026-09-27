import { DurableObject } from 'cloudflare:workers'
import { findDeal } from '../shared/deals'
import type { BuyerRole } from '../shared/economics'
import { settle } from '../shared/economics'
import { type Candidate, findMatch } from '../shared/matchmaker'
import {
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol'
import { type Env, intVar } from './env'

interface BuyerIdentity {
  connId: string
  name: string
  dealId: string
  lat: number
  lng: number
  joinedAt: number
}

type ConnState =
  | { status: 'idle'; connId: string }
  | ({ status: 'waiting' } & BuyerIdentity)
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

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)

    const connId = crypto.randomUUID()
    this.setState(server, { status: 'idle', connId })

    const cell = new URL(request.url).searchParams.get('cell') ?? ''
    this.send(server, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      cell,
      waiting: this.waitingStates().length,
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
      case 'join':
        await this.handleJoin(ws, msg.name, msg.dealId, msg.lat, msg.lng)
        return
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws)
  }

  private async handleJoin(
    ws: WebSocket,
    name: string,
    dealId: string,
    lat: number,
    lng: number,
  ): Promise<void> {
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
      name,
      dealId,
      lat,
      lng,
      joinedAt: Date.now(),
    }
    const others = this.waitingStates()
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
  }

  private handleCancel(ws: WebSocket): void {
    const state = this.getState(ws)
    if (state === null) return
    if (state.status !== 'waiting') {
      this.fail(ws, 'not_waiting', 'nothing to cancel')
      return
    }
    this.setState(ws, { status: 'idle', connId: state.connId })
  }

  /**
   * Drop a connection, and if it was half of a match, return the abandoned
   * buddy to the queue rather than leaving them staring at a dead match.
   */
  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const state = this.getState(ws)
    if (state === null || state.status !== 'matched') return

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
  const { connId, name, dealId, lat, lng, joinedAt } = state
  return { connId, name, dealId, lat, lng, joinedAt }
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

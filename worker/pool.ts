import { DurableObject } from 'cloudflare:workers'
import { findDeal } from '../shared/deals'
import type { BuyerRole, Settlement } from '../shared/economics'
import { settle } from '../shared/economics'
import { type Candidate, findMatch } from '../shared/matchmaker'
import {
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol'
import { type Env, intVar, stripeConfigured } from './env'
import {
  applyPaymentOutcome,
  openLedger,
  type PaymentLedger,
  type PaymentLeg,
  parsePaymentOutcome,
  paymentIntentSpecs,
  pickupCode,
  refundIdempotencyKey,
  unwindLedger,
} from './lib/payments'
import { createPaymentIntent, refundPaymentIntent, type StripeClientConfig } from './lib/stripe'

/**
 * Where the Worker forwards a signature-verified Stripe event. Not a route a
 * browser can reach: the only way in is a Durable Object stub.
 */
export const INTERNAL_PAYMENT_PATH = '/__internal/payment'

/** Storage key for the cell name, which the DO needs for PaymentIntent metadata. */
const CELL_KEY = 'cell'

interface BuyerIdentity {
  connId: string
  name: string
  dealId: string
  lat: number
  lng: number
  joinedAt: number
}

/**
 * `matched` means paired and owing money; `cleared` means both halves paid and
 * the pickup code released. They are separate states because the difference
 * between them is the difference between a buyer who can collect a box and one
 * who cannot, and collapsing them is how a half-paid match shows a pickup code.
 */
type ConnState =
  | { status: 'idle'; connId: string }
  | ({ status: 'waiting' } & BuyerIdentity)
  | ({ status: 'matched'; matchId: string; role: BuyerRole } & BuyerIdentity)
  | ({ status: 'cleared'; matchId: string; role: BuyerRole } & BuyerIdentity)

type WaitingState = Extract<ConnState, { status: 'waiting' }>
type PairedState = Extract<ConnState, { status: 'matched' | 'cleared' }>

interface MatchRecord {
  matchId: string
  dealId: string
  createdAt: number
  ordererConnId: string
  receiverConnId: string
  distanceMeters: number
  /** Absent only for a match made while Stripe is unconfigured. */
  ledger?: PaymentLedger
}

function isPaired(state: ConnState): state is PairedState {
  return state.status === 'matched' || state.status === 'cleared'
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

  private get stripe(): StripeClientConfig | null {
    return stripeConfigured(this.env) ? { secretKey: this.env.STRIPE_SECRET_KEY } : null
  }

  override async fetch(request: Request): Promise<Response> {
    // Two ways in: a buyer's socket, and a signature-verified Stripe event the
    // Worker forwarded here because this instance owns the match.
    if (new URL(request.url).pathname === INTERNAL_PAYMENT_PATH) {
      return this.handlePaymentEvent(request)
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)

    const connId = crypto.randomUUID()
    this.setState(server, { status: 'idle', connId })

    const cell = new URL(request.url).searchParams.get('cell') ?? ''
    // Stashed because a PaymentIntent has to name the cell in its metadata:
    // that is the only breadcrumb the stateless webhook route can follow back
    // to this instance.
    await this.ctx.storage.put(CELL_KEY, cell)
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
    if (isPaired(state)) {
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

    await this.startPayments(matchId, deal.label, settlement)
  }

  /**
   * Put both halves of a fresh match up for payment.
   *
   * Amounts come out of the settlement untouched — see `paymentIntentSpecs` —
   * and each intent is keyed on `${matchId}:${role}`, so a retried match
   * message resolves to the charge that already exists rather than a second
   * one.
   */
  private async startPayments(
    matchId: string,
    dealLabel: string,
    settlement: Settlement,
  ): Promise<void> {
    const stripe = this.stripe
    if (stripe === null) {
      // No Stripe secrets bound: `vite dev` and the smoke test pair buyers
      // without money changing hands. A deployment missing its secrets is a
      // misconfiguration, and the README runbook says so.
      console.warn('NuggPool: STRIPE secrets unset — clearing match %s uncharged', matchId)
      await this.clearMatch(matchId)
      return
    }

    const cell = (await this.ctx.storage.get<string>(CELL_KEY)) ?? ''
    const specs = paymentIntentSpecs(settlement, {
      matchId,
      cell,
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
      for (const { ws } of this.pairedWith(matchId)) {
        this.fail(ws, 'payment_unavailable', 'could not reach the payment processor')
      }
      await this.abandonMatch(matchId, null, true)
      return
    }

    const record = await this.ctx.storage.get<MatchRecord>(`match:${matchId}`)
    if (record === undefined) return
    const ledger = openLedger(
      settlement,
      { matchId, cell },
      created.map((intent) => intent.id),
    )
    await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, { ...record, ledger })

    for (const { ws, state } of this.pairedWith(matchId)) {
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
    if (record?.ledger === undefined) {
      // Already unwound, already collected, or never ours. Acknowledge so
      // Stripe stops retrying a delivery nobody is waiting for.
      return Response.json({ ok: true, effect: 'unknown_match' })
    }

    const { ledger, effect } = applyPaymentOutcome(record.ledger, outcome)
    await this.ctx.storage.put<MatchRecord>(`match:${outcome.matchId}`, { ...record, ledger })

    switch (effect.kind) {
      case 'cleared':
        await this.clearMatch(outcome.matchId)
        break
      case 'unwind':
        await this.refund(effect.refund, outcome.matchId)
        await this.unwindMatch(outcome.matchId, effect.failedRole)
        break
      default:
        break
    }

    return Response.json({ ok: true, effect: effect.kind })
  }

  /** Both halves paid: promote both connections and hand out the pickup code. */
  private async clearMatch(matchId: string): Promise<void> {
    const code = pickupCode(matchId)
    for (const { ws, state } of this.pairedWith(matchId)) {
      this.setState(ws, { ...identityOf(state), status: 'cleared', matchId, role: state.role })
      this.send(ws, { type: 'payment_cleared', matchId, pickupCode: code })
    }
  }

  /**
   * A half will never be paid, so there is no box. Tell both buyers whose
   * side broke and put them back in the queue at the back.
   */
  private async unwindMatch(matchId: string, failedRole: BuyerRole): Promise<void> {
    for (const { ws, state } of this.pairedWith(matchId)) {
      const requeued: WaitingState = {
        ...identityOf(state),
        status: 'waiting',
        joinedAt: Date.now(),
      }
      this.setState(ws, requeued)
      this.send(ws, {
        type: 'payment_failed',
        matchId,
        whose: state.role === failedRole ? 'you' : 'buddy',
        // The buyer who failed has nothing to refund; the other one does.
        refunded: state.role !== failedRole,
      })
      this.sendWaiting(ws, requeued)
    }
    await this.ctx.storage.delete(`match:${matchId}`)
  }

  /**
   * Tear a match down for a non-payment reason: a buddy who walked away, or a
   * processor that would not open the charges.
   *
   * `refundCollected` is false only for a match that had already cleared —
   * both halves paid, pickup code out — where a closing tab is a finished
   * transaction and handing the money back would be handing back the price of
   * a box that was collected.
   */
  private async abandonMatch(
    matchId: string,
    except: WebSocket | null,
    refundCollected: boolean,
  ): Promise<void> {
    const record = await this.ctx.storage.get<MatchRecord>(`match:${matchId}`)
    if (refundCollected && record?.ledger !== undefined) {
      const { ledger, refund } = unwindLedger(record.ledger)
      await this.ctx.storage.put<MatchRecord>(`match:${matchId}`, { ...record, ledger })
      await this.refund(refund, matchId)
    }

    for (const { ws, state } of this.pairedWith(matchId)) {
      if (ws === except) continue
      const requeued: WaitingState = {
        ...identityOf(state),
        // Requeued at the back, so they do not jump buyers who waited honestly.
        status: 'waiting',
        joinedAt: Date.now(),
      }
      this.setState(ws, requeued)
      this.send(ws, { type: 'buddy_left', matchId })
      // Without this the survivor's UI would keep showing the pool count from
      // before they were matched, which for an instant match is zero.
      this.sendWaiting(ws, requeued)
    }
    await this.ctx.storage.delete(`match:${matchId}`)
  }

  private async refund(legs: PaymentLeg[], matchId: string): Promise<void> {
    const stripe = this.stripe
    if (stripe === null || legs.length === 0) return
    for (const leg of legs) {
      try {
        await refundPaymentIntent(stripe, {
          paymentIntentId: leg.paymentIntentId,
          idempotencyKey: refundIdempotencyKey(matchId, leg.role),
        })
      } catch (error) {
        // A stuck refund is a money problem for a human, not a reason to leave
        // the buyer staring at a dead match.
        console.error('NuggPool: refund failed for %s (%s): %o', matchId, leg.role, error)
      }
    }
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
   *
   * Anything collected for a match that had not yet cleared is refunded: the
   * buyer who stayed has paid for a box that is not being ordered. A match
   * that had already cleared keeps its money — the code was issued, the box
   * was bought.
   */
  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const state = this.getState(ws)
    if (state === null || !isPaired(state)) return
    await this.abandonMatch(state.matchId, ws, state.status !== 'cleared')
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

  /** Every live connection that is part of one match, in no particular order. */
  private pairedWith(matchId: string): { ws: WebSocket; state: PairedState }[] {
    const out: { ws: WebSocket; state: PairedState }[] = []
    for (const { ws, state } of this.states()) {
      if (isPaired(state) && state.matchId === matchId) out.push({ ws, state })
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

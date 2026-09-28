/**
 * What a match owes, who has paid, and what to do when one of them does not.
 *
 * Deliberately free of both Stripe and the Workers runtime: the interesting
 * question — "one buyer paid, the other's card declined, now what?" — is a
 * state machine, and a state machine that can only be exercised against a live
 * payment processor is a state machine nobody exercises. `worker/pool.ts`
 * performs the effects this module decides on.
 *
 * Every amount here is integer cents and originates in `settle()`. Nothing in
 * this file multiplies, divides or rounds money.
 */

import { isDemoUserId } from '../../shared/demo'
import type { BuyerRole, Settlement } from '../../shared/economics'

/** Stripe wants a currency; the whole catalogue is US retail. */
export const PAYMENT_CURRENCY = 'usd'

/**
 * What this pool is allowed to do about money for one particular match.
 *
 * - `charge` — open two PaymentIntents and hold the pickup code until both clear.
 * - `demo` — a demo pairing. No money, ever: these pairs are already excluded
 *   from the D1 ledger (`worker/ledger.ts`), and charging a real card for a
 *   throwaway `demo:` identity would be worse than booking one.
 * - `uncharged` — an operator has explicitly said this server pairs for free.
 * - `refuse` — payments are not configured and nobody said that was intentional.
 *   Fail closed: no match, no code, no charge.
 */
export type PaymentDisposition = 'charge' | 'demo' | 'uncharged' | 'refuse'

/** Whether a disposition means a pickup code may be released at match time. */
export function codeAtMatchTime(disposition: PaymentDisposition): boolean {
  return disposition === 'demo' || disposition === 'uncharged'
}

/**
 * Decide how one match is paid for — the single decision both the Stripe call
 * and the pickup-code release read, so the two can never disagree.
 *
 * The order of these branches is the security property:
 *
 * 1. **Demo first**, so a demo pair is excluded on a *fully configured*
 *    production deploy too, not merely on a laptop with no secrets. This is the
 *    one ordering that makes "demo pairs never reach Stripe" true rather than
 *    accidentally true.
 * 2. **Charge whenever Stripe is configured**, so the escape hatch below cannot
 *    silently disable a working payment path.
 * 3. **Uncharged only when the secrets are absent *and* an operator opted in** —
 *    a conjunction, so an empty production secret is never indistinguishable
 *    from intentional test mode.
 * 4. **Refuse otherwise.** An unset secret must cost a match, not a box.
 */
export function paymentDisposition(input: {
  stripeConfigured: boolean
  unchargedAllowed: boolean
  userIds: Record<BuyerRole, string>
}): PaymentDisposition {
  if (isDemoUserId(input.userIds.orderer) || isDemoUserId(input.userIds.receiver)) return 'demo'
  switch (serverPaymentMode(input)) {
    case 'live':
      return 'charge'
    case 'uncharged':
      return 'uncharged'
    default:
      return 'refuse'
  }
}

/**
 * What this server can do about money at all, independent of any one match.
 *
 * Reported on `/api/health` so an end-to-end check can assert which side of the
 * gate the server it is talking to actually sits on, rather than discovering it
 * from the behaviour it was supposed to be testing. Sharing steps 2-4 with
 * `paymentDisposition` above is the point: the mode a server *claims* and the
 * decision it *makes* cannot drift apart.
 */
export function serverPaymentMode(input: {
  stripeConfigured: boolean
  unchargedAllowed: boolean
}): 'live' | 'uncharged' | 'unconfigured' {
  if (input.stripeConfigured) return 'live'
  if (input.unchargedAllowed) return 'uncharged'
  return 'unconfigured'
}

export type LegStatus = 'pending' | 'succeeded' | 'failed' | 'refunded'

export interface PaymentLeg {
  role: BuyerRole
  paymentIntentId: string
  /** Copied from `share.payCents`, never recomputed. */
  amountCents: number
  status: LegStatus
}

/** Metadata carried on the PaymentIntent, and echoed back by the webhook. */
export interface PaymentMetadata {
  match_id: string
  role: BuyerRole
  deal_id: string
  /**
   * The geohash cell, which is also the name of the NuggPool Durable Object
   * holding this match. Without it a webhook arriving at the stateless Worker
   * has no way to find the instance that owns the two sockets.
   */
  cell: string
}

export interface PaymentIntentSpec {
  role: BuyerRole
  amountCents: number
  currency: string
  /**
   * `${matchId}:${role}`. A socket retry, a duplicated match message or a
   * Worker retry all resolve to the same key, so Stripe returns the original
   * intent instead of creating a second charge.
   */
  idempotencyKey: string
  description: string
  metadata: PaymentMetadata
}

export interface PaymentLedger {
  matchId: string
  cell: string
  dealId: string
  /** `settlement.totalCollectedCents` — what both halves come to together. */
  totalCollectedCents: number
  /** `settlement.cogsCents` — what the merchant gets for the box. */
  cogsCents: number
  /** `settlement.platformFeeCents` — the pairing fee, retained only if both halves clear. */
  platformFeeCents: number
  /** Orderer first, mirroring `settlement.shares`. */
  legs: PaymentLeg[]
}

export type PaymentOutcome = 'succeeded' | 'failed'

/** A payment result forwarded from the webhook into the owning Durable Object. */
export interface PaymentOutcomeRequest {
  matchId: string
  role: BuyerRole
  paymentIntentId: string
  outcome: PaymentOutcome
}

export type PaymentEffect =
  /** Nothing to do: unknown leg, or a replay of a result already recorded. */
  | { kind: 'noop'; reason: 'unknown_leg' | 'already_final' | 'match_over' }
  /** This half is in; the other has not landed yet. */
  | { kind: 'pending' }
  /** Both halves paid. Release the match's pickup code to the orderer. */
  | { kind: 'cleared' }
  /**
   * A half will never be paid, so the match is dead. Refund every leg in
   * `refund` (they were charged for a box that is not happening) and take both
   * buyers off this match.
   */
  | { kind: 'unwind'; failedRole: BuyerRole; refund: PaymentLeg[] }

export interface PaymentTransition {
  ledger: PaymentLedger
  effect: PaymentEffect
}

function roleOf(index: number): BuyerRole {
  return index === 0 ? 'orderer' : 'receiver'
}

/**
 * The two charges a settled match implies.
 *
 * Amounts are lifted straight out of the settlement, in the settlement's own
 * order, so the sum of what Stripe collects is `totalCollectedCents` by
 * construction rather than by a second, drift-prone calculation.
 */
export function paymentIntentSpecs(
  settlement: Settlement,
  context: { matchId: string; cell: string; description: string },
): PaymentIntentSpec[] {
  return settlement.shares.map((share, i) => ({
    role: roleOf(i),
    amountCents: share.payCents,
    currency: PAYMENT_CURRENCY,
    idempotencyKey: `${context.matchId}:${roleOf(i)}`,
    description: context.description,
    metadata: {
      match_id: context.matchId,
      role: roleOf(i),
      deal_id: settlement.dealId,
      cell: context.cell,
    },
  }))
}

/** Open a ledger for a match whose PaymentIntents have just been created. */
export function openLedger(
  settlement: Settlement,
  context: { matchId: string; cell: string },
  intentIds: string[],
): PaymentLedger {
  return {
    matchId: context.matchId,
    cell: context.cell,
    dealId: settlement.dealId,
    totalCollectedCents: settlement.totalCollectedCents,
    cogsCents: settlement.cogsCents,
    platformFeeCents: settlement.platformFeeCents,
    legs: settlement.shares.map((share, i) => ({
      role: roleOf(i),
      paymentIntentId: intentIds[i],
      amountCents: share.payCents,
      status: 'pending',
    })),
  }
}

/** Total actually collected from buyers right now, in cents. */
export function collectedCents(ledger: PaymentLedger): number {
  return ledger.legs.reduce(
    (sum, leg) => (leg.status === 'succeeded' ? sum + leg.amountCents : sum),
    0,
  )
}

/**
 * The pairing fee this match has actually earned.
 *
 * Only a fully-paid match earns it: the box costs `cogsCents` whether or not
 * the second half lands, so a half-collected match is a loss to be refunded,
 * not a fee to be booked.
 */
export function retainedFeeCents(ledger: PaymentLedger): number {
  const collected = collectedCents(ledger)
  return collected === ledger.totalCollectedCents ? ledger.platformFeeCents : 0
}

/**
 * Has every half of this match actually been paid?
 *
 * The gate on releasing a pickup code and, through `handleConfirmPickup`, on
 * reaching a D1 ledger row at all. Deliberately not `collectedCents === total`:
 * a leg that succeeded and was then refunded leaves the arithmetic ambiguous,
 * and the statuses are not.
 */
export function allLegsPaid(ledger: PaymentLedger): boolean {
  return ledger.legs.length > 0 && ledger.legs.every((leg) => leg.status === 'succeeded')
}

/**
 * Fold a payment result into the ledger and decide what the pool should do.
 *
 * Replays are absorbed here as well as at Stripe: a webhook delivered twice
 * finds its leg already final and yields a `noop`, so a duplicate
 * `payment_intent.succeeded` cannot clear a match twice or a duplicate failure
 * refund twice.
 */
export function applyPaymentOutcome(
  ledger: PaymentLedger,
  result: PaymentOutcomeRequest,
): PaymentTransition {
  const index = ledger.legs.findIndex(
    (leg) => leg.role === result.role && leg.paymentIntentId === result.paymentIntentId,
  )
  if (index === -1) return { ledger, effect: { kind: 'noop', reason: 'unknown_leg' } }

  const leg = ledger.legs[index]
  if (leg.status !== 'pending') {
    return { ledger, effect: { kind: 'noop', reason: 'already_final' } }
  }
  // A match killed by the other half is already unwound; a late success on this
  // half is refunded by the caller, not folded back into a live match.
  if (ledger.legs.some((other) => other.status === 'failed' || other.status === 'refunded')) {
    const settledLeg: PaymentLeg = {
      ...leg,
      status: result.outcome === 'succeeded' ? 'succeeded' : 'failed',
    }
    const next = replaceLeg(ledger, index, settledLeg)
    if (result.outcome !== 'succeeded') {
      return { ledger: next, effect: { kind: 'noop', reason: 'match_over' } }
    }
    return {
      ledger: markRefunded(next, [settledLeg]),
      effect: { kind: 'unwind', failedRole: otherRole(result.role), refund: [settledLeg] },
    }
  }

  if (result.outcome === 'succeeded') {
    const next = replaceLeg(ledger, index, { ...leg, status: 'succeeded' })
    if (allLegsPaid(next)) return { ledger: next, effect: { kind: 'cleared' } }
    return { ledger: next, effect: { kind: 'pending' } }
  }

  const next = replaceLeg(ledger, index, { ...leg, status: 'failed' })
  const refund = next.legs.filter((l) => l.status === 'succeeded')
  return {
    ledger: markRefunded(next, refund),
    effect: { kind: 'unwind', failedRole: result.role, refund },
  }
}

/**
 * Tear a match down for a reason other than a declined card — a buddy who
 * walked away, or a PaymentIntent that could not be created at all. Whatever
 * has been collected is refunded, because there is no box.
 */
export function unwindLedger(ledger: PaymentLedger): {
  ledger: PaymentLedger
  refund: PaymentLeg[]
} {
  const refund = ledger.legs.filter((leg) => leg.status === 'succeeded')
  return { ledger: markRefunded(ledger, refund), refund }
}

function otherRole(role: BuyerRole): BuyerRole {
  return role === 'orderer' ? 'receiver' : 'orderer'
}

function replaceLeg(ledger: PaymentLedger, index: number, leg: PaymentLeg): PaymentLedger {
  const legs = ledger.legs.slice()
  legs[index] = leg
  return { ...ledger, legs }
}

function markRefunded(ledger: PaymentLedger, refund: PaymentLeg[]): PaymentLedger {
  if (refund.length === 0) return ledger
  const ids = new Set(refund.map((leg) => leg.paymentIntentId))
  return {
    ...ledger,
    legs: ledger.legs.map((leg) =>
      ids.has(leg.paymentIntentId) ? { ...leg, status: 'refunded' } : leg,
    ),
  }
}

/** The idempotency key for unwinding one leg. One refund per leg, ever. */
export function refundIdempotencyKey(matchId: string, role: BuyerRole): string {
  return `refund:${matchId}:${role}`
}

/**
 * Narrow the payment result the Worker forwards into the Durable Object.
 *
 * The Worker has already verified the Stripe signature, but this crosses a
 * request boundary that a Durable Object stub is not the only way to reach, so
 * it is validated rather than cast — the same rule the WebSocket protocol
 * follows.
 */
export function parsePaymentOutcome(raw: string): PaymentOutcomeRequest | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>

  const { matchId, role, paymentIntentId, outcome } = msg
  if (typeof matchId !== 'string' || matchId.length === 0) return null
  if (typeof paymentIntentId !== 'string' || paymentIntentId.length === 0) return null
  if (role !== 'orderer' && role !== 'receiver') return null
  if (outcome !== 'succeeded' && outcome !== 'failed') return null
  return { matchId, role, paymentIntentId, outcome }
}

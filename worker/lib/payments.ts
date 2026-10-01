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
import { isHoneypotUserId } from '../../shared/honeypot'

/** Stripe wants a currency; the whole catalogue is US retail. */
export const PAYMENT_CURRENCY = 'usd'

/**
 * What this pool is allowed to do about money for one particular match.
 *
 * - `charge` — open two PaymentIntents and hold the pickup code until both clear.
 * - `honeypot` — one side is a decoy (`shared/honeypot.ts`). No money, ever, and
 *   **no pickup code ever either** — see `codeAtMatchTime` below. A honeypot
 *   reaching `charge` on a live deployment would take a real buyer's money for a
 *   handoff that cannot happen.
 * - `demo` — a demo pairing. No money, ever: these pairs are already excluded
 *   from the D1 ledger (`worker/ledger.ts`), and charging a real card for a
 *   throwaway `demo:` identity would be worse than booking one.
 * - `uncharged` — an operator has explicitly said this server pairs for free.
 * - `refuse` — payments are not configured and nobody said that was intentional.
 *   Fail closed: no match, no code, no charge.
 */
export type PaymentDisposition = 'charge' | 'honeypot' | 'demo' | 'uncharged' | 'refuse'

/**
 * Whether a disposition means a pickup code may be released at match time.
 *
 * `honeypot` is false, and that single `false` is the structural safety argument
 * for the whole feature rather than a detail of it. No code released means
 * `pickupUnlocked` is false forever (a honeypot match has no ledger to unlock
 * it either), so `handleConfirmPickup` refuses; no confirmation is ever recorded,
 * so `bothConfirmed` can never fire — no `matches` row — and every route into
 * `disputeMatch` requires one side to have confirmed, so no `disputes` row
 * either. None of that depends on a timer firing in the right order.
 */
export function codeAtMatchTime(disposition: PaymentDisposition): boolean {
  return disposition === 'demo' || disposition === 'uncharged'
}

/**
 * Decide how one match is paid for — the single decision both the Stripe call
 * and the pickup-code release read, so the two can never disagree.
 *
 * The order of these branches is the security property:
 *
 * 1. **Honeypot first**, ahead of everything including demo. A decoy is not a
 *    person, so there is no card to charge and nobody to hand a box to — a
 *    honeypot that reached `charge` on a configured deployment would collect a
 *    real buyer's money for a handoff that cannot happen. Decided from identity
 *    rather than from a flag, and before the secrets are read, so it is true on a
 *    fully configured production deploy and not merely on a laptop.
 * 2. **Demo next**, so a demo pair is excluded on a *fully configured*
 *    production deploy too, not merely on a laptop with no secrets. This is the
 *    one ordering that makes "demo pairs never reach Stripe" true rather than
 *    accidentally true.
 * 3. **Charge whenever Stripe is configured**, so the escape hatch below cannot
 *    silently disable a working payment path.
 * 4. **Uncharged only when the secrets are absent *and* an operator opted in** —
 *    a conjunction, so an empty production secret is never indistinguishable
 *    from intentional test mode.
 * 5. **Refuse otherwise.** An unset secret must cost a match, not a box.
 */
export function paymentDisposition(input: {
  stripeConfigured: boolean
  unchargedAllowed: boolean
  userIds: Record<BuyerRole, string>
}): PaymentDisposition {
  if (isHoneypotUserId(input.userIds.orderer) || isHoneypotUserId(input.userIds.receiver)) {
    return 'honeypot'
  }
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
  /**
   * Copied from `share.payCents`, never recomputed.
   *
   * A ledger figure, not a gate: `collectedCents`, `centsFor` and `totalCents`
   * read it to say what is held and what was handed back, and that is the whole
   * of its job. **The fold decides nothing from it** — `foldLeg` reads `status`
   * and `closedAt` alone and is not even handed an amount, and a leg is found by
   * role and `paymentIntentId`. Two reasons a disagreement cannot be a *gate*
   * (#95):
   *
   * 1. It cannot disagree with the settlement. `openLedger` writes every leg
   *    from `settlement.shares` in one expression and `divideCents` guarantees
   *    those shares sum back to `totalCollectedCents` exactly, so comparing the
   *    two here would assert a tautology rather than catch anything.
   * 2. It could disagree with *Stripe*, and a reducer could not act on that
   *    either. By the time a `payment_intent.succeeded` arrives the money is
   *    already collected, so refusing to fold the leg in would strand it
   *    uncollected *and* unrefunded, which is strictly worse than recording it
   *    and letting the teardown paths hand it back.
   *
   * Neither reason rules out an *observation*, which is what #170 added: Stripe's
   * own figure now reaches `applyPaymentOutcome` on the request and is compared
   * against this one, reported beside the fold as a `PaymentAmountMismatch` and
   * never adopted onto the leg. See that type for why reporting rather than
   * adopting is the decision.
   */
  amountCents: number
  status: LegStatus
}

/** Metadata carried on the PaymentIntent, and echoed back by the webhook. */
export interface PaymentMetadata {
  match_id: string
  role: BuyerRole
  deal_id: string
  /**
   * The geohash shard, which is also the name of the NuggPool Durable Object
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
  /**
   * When this ledger stopped belonging to a live match, if it has.
   *
   * Set by `retireLedger` at the moment the match record is deleted, and it is
   * what makes `applyPaymentOutcome`'s late-success branch *reachable*: a
   * PaymentIntent can clear seconds after its match died (3DS behind a decline
   * on the other half), and a ledger that cannot say "this match is over" has no
   * way to tell that money apart from money for a match still in flight.
   */
  closedAt?: number
}

/**
 * What a retired match leaves behind so its money can still be answered for.
 *
 * Deliberately *only* the charges. No pickup code, no settlement, no buyers, no
 * confirmations: a tombstone must never be a second route to a code or to a D1
 * ledger row, and the cheapest way to guarantee that is for it not to contain
 * the things those paths read. `pickupUnlocked` and `completeMatch` both take a
 * `MatchRecord`, which this is not.
 */
export interface PaymentTombstone {
  matchId: string
  /** Closed: `closedAt` is set, so a late success folds to `late_refund`. */
  ledger: PaymentLedger
  retiredAt: number
}

export type PaymentOutcome = 'succeeded' | 'failed'

/** A payment result forwarded from the webhook into the owning Durable Object. */
export interface PaymentOutcomeRequest {
  matchId: string
  role: BuyerRole
  paymentIntentId: string
  outcome: PaymentOutcome
  /**
   * What Stripe says this PaymentIntent is for, in cents — the `amount` on the
   * event object, as `parsePaymentEvent` narrowed it.
   *
   * Required rather than optional, and that is the point. An amount the Worker
   * could stop sending would make "the two figures agreed" and "nobody looked"
   * the same answer, which is the shape of every cross-check in this repo that
   * turned out to enforce nothing. The one caller has it on a signature-verified
   * event, so no legitimate path lacks it, and `parsePaymentOutcome` refuses a
   * body without one rather than cross-checking against a default.
   */
  amountCents: number
}

/**
 * Stripe's amount for a PaymentIntent and the ledger leg's, when they differ.
 *
 * **Reported, never adopted — a decision, not an omission (#170).** Stripe is
 * the authority on money that actually moved, so adopting its figure onto the
 * leg is the tempting repair: `collectedCents` would then say what was really
 * collected, and a late `refundedCents` would be Stripe's own number instead of
 * ours summed from legs. It is refused for three reasons:
 *
 * 1. Adopting corrects one figure and quietly breaks the settlement-relative
 *    ones. `amountCents` is not merely "what moved", it is *this leg's share of
 *    a settlement*, and `retainedFeeCents` books the pairing fee only while
 *    `collectedCents` equals `totalCollectedCents`. One adopted cent on a match
 *    that otherwise cleared normally would zero the fee, with nothing anywhere
 *    recording why.
 * 2. A disagreement is not a rounding to absorb. It is evidence that what was
 *    charged is not what the settlement asked Stripe for, which is an operator
 *    question — and this repo's answer to money it cannot account for is to
 *    surface it (`holds`, `disputes`), never to rewrite the record underneath it.
 * 3. Reporting loses nothing and stays reversible. Both figures ride out on the
 *    webhook's own answer, which for the late paths is the only place money is
 *    observable outside the Durable Object at all. Adopting overwrites a
 *    settlement figure with no record that it was overwritten; if drift is ever
 *    actually observed, adopting can be decided then, from a real case.
 *
 * Its *presence* is the whole signal, so the two figures are never equal — a
 * report claiming otherwise is refused by `parsePaymentEventReport`.
 */
export interface PaymentAmountMismatch {
  role: BuyerRole
  paymentIntentId: string
  /** The leg's figure: `share.payCents`, as `openLedger` copied it. */
  ledgerCents: number
  /** Stripe's figure for the same PaymentIntent, off the verified event. */
  stripeCents: number
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
  /**
   * Money that landed for a match which is already over. There is no match to
   * fold it into and nobody to tell — refund the legs in `refund` and leave the
   * tombstone holding whatever Stripe would not take back.
   */
  | { kind: 'late_refund'; refund: PaymentLeg[] }

export interface PaymentTransition {
  ledger: PaymentLedger
  effect: PaymentEffect
  /**
   * Set when Stripe's reported amount disagreed with the leg this result was
   * folded into, and absent otherwise.
   *
   * Beside `effect` rather than inside it, deliberately: the fold is identical
   * either way, so no caller has to branch on this to do the right thing with the
   * money. It is an observation travelling alongside a decision.
   */
  amountMismatch?: PaymentAmountMismatch
}

/**
 * What a payment event resolved to, as the Durable Object reports it.
 *
 * `unknown_match` is the one answer no `PaymentEffect` can produce: it is the
 * pool having neither a record nor a tombstone for the match, which is a
 * decision about routing rather than about money.
 */
export type PaymentEventEffect = PaymentEffect['kind'] | 'unknown_match'

/**
 * A map rather than a list so a new `PaymentEffect` kind fails `tsc` here,
 * instead of being silently refused by the parser below and reported to Stripe
 * as an unreadable answer.
 */
const PAYMENT_EVENT_EFFECTS: Record<PaymentEventEffect, true> = {
  noop: true,
  pending: true,
  cleared: true,
  unwind: true,
  late_refund: true,
  unknown_match: true,
}

/**
 * What the pool did about one payment result, on its way back out to the
 * webhook's caller.
 *
 * The late paths are the reason this exists. A leg that clears after its match
 * died is refunded by a tombstone nobody can enumerate — there is no registry of
 * live cells — so the webhook's own answer is the only place that outcome is
 * visible from outside the Durable Object. It used to be a flat
 * `{ ok, handled: true }`, which made "the money went back" and "Stripe refused
 * the refund and we are sitting on it" the same 200.
 */
export interface PaymentEventReport {
  effect: PaymentEventEffect
  /**
   * Money for a match that is already over, rather than money folded into a live
   * one. Every late answer carries `refundedCents` and `heldCents`; a live answer
   * carries neither, because a live teardown reports its money to the two buyers
   * over their own sockets and there is nobody left to tell on a late one.
   */
  late: boolean
  /** Late answers only. Summed from the legs Stripe *confirmed* a refund for. */
  refundedCents?: number
  /** Late answers only. Still collected once those confirmed refunds landed. */
  heldCents?: number
  /**
   * The cross-check (#170): Stripe's amount against the leg it was folded into,
   * present only when the two disagreed.
   *
   * Carried on live answers as well as late ones, unlike the money figures. Those
   * are absent on a live answer because the two buyers are told them over their
   * own sockets; an amount neither buyer is ever shown has no such second channel,
   * and the `refundedCents` every operator figure is summed from is this figure —
   * so a live match quietly charged something other than its settlement share
   * would otherwise be visible nowhere.
   */
  amountMismatch?: PaymentAmountMismatch
}

/**
 * Narrow a reported mismatch, or refuse it.
 *
 * Equal figures are refused rather than passed through as a mismatch of zero:
 * the field's presence is the signal, so a report that says "they disagreed" and
 * then names one number twice is not readable, and reading it as a disagreement
 * would put an operator onto a match where nothing happened.
 */
function parseAmountMismatch(value: unknown): PaymentAmountMismatch | null {
  if (typeof value !== 'object' || value === null) return null
  const { role, paymentIntentId, ledgerCents, stripeCents } = value as Record<string, unknown>
  if (role !== 'orderer' && role !== 'receiver') return null
  if (typeof paymentIntentId !== 'string' || paymentIntentId.length === 0) return null
  if (!Number.isInteger(ledgerCents) || !Number.isInteger(stripeCents)) return null
  if ((ledgerCents as number) < 0 || (stripeCents as number) < 0) return null
  if (ledgerCents === stripeCents) return null
  return {
    role,
    paymentIntentId,
    ledgerCents: ledgerCents as number,
    stripeCents: stripeCents as number,
  }
}

/**
 * Narrow the pool's answer before the Worker repeats it to Stripe.
 *
 * Validated rather than cast for the same reason `parsePaymentOutcome` validates
 * the other direction: this crosses a request boundary, and a shape the route
 * cannot read must become a plain acknowledgement rather than a 200 carrying
 * half a money figure.
 */
export function parsePaymentEventReport(payload: unknown): PaymentEventReport | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { effect, late, refundedCents, heldCents, amountMismatch } = payload as Record<
    string,
    unknown
  >
  if (typeof effect !== 'string' || !Object.hasOwn(PAYMENT_EVENT_EFFECTS, effect)) return null
  if (typeof late !== 'boolean') return null

  // A mismatch this parser cannot read is refused outright rather than dropped
  // from an otherwise-good report: the same rule as the money figures below, one
  // field out. A cross-check that could not be read must never print as one that
  // found nothing.
  let cross: { amountMismatch?: PaymentAmountMismatch } = {}
  if (amountMismatch !== undefined) {
    const mismatch = parseAmountMismatch(amountMismatch)
    if (mismatch === null) return null
    cross = { amountMismatch: mismatch }
  }

  const kind = effect as PaymentEventEffect
  if (!late) return { effect: kind, late: false, ...cross }
  // A late answer without both halves of the money is the ambiguity this report
  // exists to remove, so it is not a late answer at all.
  if (!Number.isInteger(refundedCents) || !Number.isInteger(heldCents)) return null
  if ((refundedCents as number) < 0 || (heldCents as number) < 0) return null
  return {
    effect: kind,
    late: true,
    refundedCents: refundedCents as number,
    heldCents: heldCents as number,
    ...cross,
  }
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
 *
 * A leg is identified by role *and* `paymentIntentId`, and never by amount. The
 * amount is *compared* — see `PaymentAmountMismatch` — and the comparison is
 * structural rather than promised: `foldLeg` below is handed the outcome alone,
 * so the branch that decides what happens to the money cannot read an amount
 * even by accident.
 */
export function applyPaymentOutcome(
  ledger: PaymentLedger,
  result: PaymentOutcomeRequest,
): PaymentTransition {
  const index = ledger.legs.findIndex(
    (leg) => leg.role === result.role && leg.paymentIntentId === result.paymentIntentId,
  )
  // No leg, nothing to compare against: an event for a PaymentIntent this match
  // does not own is a routing answer, not an amount one.
  if (index === -1) return { ledger, effect: { kind: 'noop', reason: 'unknown_leg' } }

  const leg = ledger.legs[index]
  // Every branch a leg was found for, replays included. A second delivery of a
  // mismatched event is still a mismatched event, and reporting it only on the
  // first would hide the signal behind whichever delivery Stripe happened to
  // retry.
  const mismatch = compareAmount(leg, result.amountCents)
  const transition = foldLeg(ledger, index, leg, result.outcome)
  return mismatch === null ? transition : { ...transition, amountMismatch: mismatch }
}

/**
 * Stripe's figure against the leg's, as an observation.
 *
 * `parsePaymentEvent` floors an event with no readable `amount` to 0, so a
 * malformed delivery reads as a disagreement rather than as agreement. That is
 * the direction to fail in: the figure is unusable either way, and a silent 0
 * matching nothing is how a cross-check comes to enforce nothing.
 */
function compareAmount(leg: PaymentLeg, stripeCents: number): PaymentAmountMismatch | null {
  if (stripeCents === leg.amountCents) return null
  return {
    role: leg.role,
    paymentIntentId: leg.paymentIntentId,
    ledgerCents: leg.amountCents,
    stripeCents,
  }
}

/** The fold itself: `status` and `closedAt`, and deliberately no amount. */
function foldLeg(
  ledger: PaymentLedger,
  index: number,
  leg: PaymentLeg,
  outcome: PaymentOutcome,
): PaymentTransition {
  if (leg.status !== 'pending') {
    return { ledger, effect: { kind: 'noop', reason: 'already_final' } }
  }
  // The match this leg belonged to is over — killed by the other half's decline,
  // by a cancellation, or by a buddy who walked away. A success arriving now is
  // money for a box that is not happening, whatever killed the match, so it is
  // refunded rather than folded into a match that no longer exists.
  //
  // Keyed on `closedAt` rather than on "some other leg looks dead": a match
  // cancelled while *both* legs were still pending leaves no failed leg behind,
  // and that shape used to clear a retired match's second half as if it were
  // live. `retireLedger` sets the field, `worker/pool.ts` persists it on the
  // tombstone, and `handleLatePaymentEvent` is what brings a webhook back here —
  // this branch is on the live path, not a predicate waiting for a caller.
  if (ledger.closedAt !== undefined) {
    const settledLeg: PaymentLeg = {
      ...leg,
      status: outcome === 'succeeded' ? 'succeeded' : 'failed',
    }
    const next = replaceLeg(ledger, index, settledLeg)
    if (outcome !== 'succeeded') {
      return { ledger: next, effect: { kind: 'noop', reason: 'match_over' } }
    }
    return { ledger: next, effect: { kind: 'late_refund', refund: [settledLeg] } }
  }

  if (outcome === 'succeeded') {
    const next = replaceLeg(ledger, index, { ...leg, status: 'succeeded' })
    if (allLegsPaid(next)) return { ledger: next, effect: { kind: 'cleared' } }
    return { ledger: next, effect: { kind: 'pending' } }
  }

  const next = replaceLeg(ledger, index, { ...leg, status: 'failed' })
  // What is *owed*, not what has been handed back: the legs stay `succeeded`
  // until Stripe confirms a refund for them. Stamping them here — before the
  // call — is how a failed refund used to leave a record claiming money had been
  // returned that was in fact still sitting in the account.
  const refund = next.legs.filter((l) => l.status === 'succeeded')
  return { ledger: next, effect: { kind: 'unwind', failedRole: leg.role, refund } }
}

/**
 * What a match owes back if it is torn down right now — a buddy who walked away,
 * a cancellation nobody confirmed, or a PaymentIntent that could not be created
 * at all. Whatever has been collected is owed back, because there is no box.
 *
 * Naming what is *owed* and leaving the stamping to `markRefunded` is the whole
 * point: only the caller knows which of these Stripe actually took back.
 */
export function refundableLegs(ledger: PaymentLedger): PaymentLeg[] {
  return ledger.legs.filter((leg) => leg.status === 'succeeded')
}

/**
 * Money this ledger has not finished with: a leg that can still land, or one
 * that was collected and has not been handed back.
 *
 * The test for whether a retired match still needs a tombstone at all.
 */
export function hasOutstandingMoney(ledger: PaymentLedger): boolean {
  return ledger.legs.some((leg) => leg.status === 'pending' || leg.status === 'succeeded')
}

/**
 * Is this ledger sitting on money a buyer is actually out of pocket for?
 *
 * Deliberately narrower than `hasOutstandingMoney` above, and the gap between
 * the two is the whole reason both exist. A `pending` leg is money nobody has
 * taken yet — a webhook to wait for, and a reason to keep a tombstone. A
 * `succeeded` leg on a match that is over is money *collected for a box that
 * does not exist*, which is a hold: somebody has to get it back, and until they
 * do it belongs in an operator's queue rather than in one Durable Object's
 * storage. `worker/pool.ts` files a `holds` row on exactly this predicate.
 */
export function holdsCollectedMoney(ledger: PaymentLedger): boolean {
  return collectedCents(ledger) > 0
}

/**
 * Close a ledger whose match is being deleted, and say whether anything about it
 * still has to be remembered.
 *
 * Returns null when nothing does — every leg failed, or every collected leg was
 * confirmably refunded — so a clean teardown leaves no residue. Otherwise the
 * tombstone is the *only* remaining record of two things a deleted match cannot
 * answer for by itself: a PaymentIntent that has not resolved yet (it may still
 * succeed, and must then be refunded), and one whose refund Stripe refused (the
 * money is still held, and a human has to reconcile it).
 */
export function retireLedger(ledger: PaymentLedger, at: number): PaymentTombstone | null {
  if (!hasOutstandingMoney(ledger)) return null
  return { matchId: ledger.matchId, ledger: { ...ledger, closedAt: at }, retiredAt: at }
}

function replaceLeg(ledger: PaymentLedger, index: number, leg: PaymentLeg): PaymentLedger {
  const legs = ledger.legs.slice()
  legs[index] = leg
  return { ...ledger, legs }
}

/**
 * Stamp `refunded` on the legs a refund was actually *confirmed* for, and only
 * those.
 *
 * Called after the Stripe round trip, never before it. A leg whose refund failed
 * stays `succeeded`, which is the truth — the money is still collected — and is
 * what keeps `collectedCents` reporting it as held rather than erasing the
 * evidence a reconciliation would need.
 */
export function markRefunded(ledger: PaymentLedger, refunded: PaymentLeg[]): PaymentLedger {
  if (refunded.length === 0) return ledger
  const ids = new Set(refunded.map((leg) => leg.paymentIntentId))
  return {
    ...ledger,
    legs: ledger.legs.map((leg) =>
      ids.has(leg.paymentIntentId) ? { ...leg, status: 'refunded' } : leg,
    ),
  }
}

/**
 * The sum of a set of legs, in cents — both roles together.
 *
 * The operator's view, where `centsFor` below is a buyer's: a late refund has no
 * sockets left to report per-role amounts to, and what an operator has to know
 * is how much of the match went back in total.
 */
export function totalCents(legs: PaymentLeg[]): number {
  return legs.reduce((sum, leg) => sum + leg.amountCents, 0)
}

/** The sum of one role's share across a set of legs, in cents. */
export function centsFor(legs: PaymentLeg[], role: BuyerRole): number {
  return legs.reduce((sum, leg) => (leg.role === role ? sum + leg.amountCents : sum), 0)
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

  const { matchId, role, paymentIntentId, outcome, amountCents } = msg
  if (typeof matchId !== 'string' || matchId.length === 0) return null
  if (typeof paymentIntentId !== 'string' || paymentIntentId.length === 0) return null
  if (role !== 'orderer' && role !== 'receiver') return null
  if (outcome !== 'succeeded' && outcome !== 'failed') return null
  // Integer cents or nothing — a fractional amount is not money in this codebase,
  // and a missing one is a body that cannot be cross-checked, which is refused
  // rather than defaulted. Stripe sends minor units, so the only way to reach
  // either branch is a body the one real caller did not build.
  if (!Number.isInteger(amountCents) || (amountCents as number) < 0) return null
  return { matchId, role, paymentIntentId, outcome, amountCents: amountCents as number }
}

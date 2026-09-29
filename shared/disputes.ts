/**
 * What a disputed pickup is, and what an operator may decide about one.
 *
 * The handshake in `shared/pickup.ts` decides *that* a split is disputed. This
 * decides what happens next, and it lives here for the same reason that one
 * does: "one buddy confirmed, the other went silent, and $8.98 is sitting in
 * the account — who gets it back?" is the part worth arguing about, and it has
 * to be arguable without a Workers runtime or a D1 binding.
 *
 * Runtime-free, like everything in `shared/`.
 */
import type { BuyerRole } from './economics'
import { sanitizeDisplayText } from './text'

/** Why a half-finished handoff became a dispute. */
export const DISPUTE_REASONS = ['timeout', 'buddy_left'] as const

export type DisputeReason = (typeof DISPUTE_REASONS)[number]

/**
 * Narrow a reason that came out of storage rather than off the call site.
 *
 * A `MatchRecord` written before the reason was persisted has none, and a
 * hand-edited one could have anything, so the D1 write parses rather than casts
 * — the column has a `CHECK` constraint and an unparseable value would fail the
 * whole batch instead of landing as a row a human can read.
 */
export function parseDisputeReason(raw: unknown): DisputeReason | null {
  return DISPUTE_REASONS.includes(raw as DisputeReason) ? (raw as DisputeReason) : null
}

/**
 * The four things an operator may decide, named for what each does to the money.
 *
 * Named that way deliberately. "Side with the orderer" reads well in a sentence
 * and is ambiguous in a ledger six months later — does the buddy who was
 * believed get their money back, or does the one who was not? Every one of these
 * says exactly who is refunded, because that is the only part of a resolution
 * that is irreversible:
 *
 * - `settled` — the handoff did happen and the silent buddy simply never tapped.
 *   Both halves stay collected; this is the split working, recorded late.
 * - `voided` — it did not happen, or it cannot be established. Both halves go
 *   back, which is the same outcome as every non-dispute teardown.
 * - `refund_orderer` / `refund_receiver` — one buddy turned up and the other did
 *   not. The one who did is made whole; the other's half stays collected.
 *
 * Deliberately *not* a free-form status: a dispute holds real money, and the
 * set of things that may happen to it is small enough to enumerate.
 */
export const DISPUTE_RESOLUTIONS = [
  'settled',
  'voided',
  'refund_orderer',
  'refund_receiver',
] as const

export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number]

/** Narrow a resolution that arrived in a request body. Hostile input. */
export function parseDisputeResolution(raw: unknown): DisputeResolution | null {
  return DISPUTE_RESOLUTIONS.includes(raw as DisputeResolution) ? (raw as DisputeResolution) : null
}

/**
 * Which buyers get their money back under a resolution.
 *
 * The single place a resolution becomes a money instruction, so the row written
 * to D1 and the refund asked of Stripe cannot disagree about what was decided.
 * `test/disputes.test.ts` enumerates the whole set from `DISPUTE_RESOLUTIONS`,
 * so adding a fifth resolution fails the build rather than silently refunding
 * nobody.
 */
export function refundedRoles(resolution: DisputeResolution): readonly BuyerRole[] {
  switch (resolution) {
    case 'settled':
      return []
    case 'voided':
      return ['orderer', 'receiver']
    case 'refund_orderer':
      return ['orderer']
    case 'refund_receiver':
      return ['receiver']
  }
}

/**
 * The two reasons a resolution a second POST asks for is refused outright.
 *
 * Both are `409`s and they are very different facts, which is why the response
 * names which one it is rather than leaving an operator to re-read the row:
 *
 * - `decided_differently` — somebody already decided, and this POST asks for
 *   something else. That is an attempt to overturn a decision that has already
 *   moved money, and it is the case the `WHERE resolved_at IS NULL` guard in
 *   `claimDispute` was written for.
 * - `refund_complete` — this *is* the stored decision and its refund has
 *   already landed in full. There is nothing left to retry.
 *
 * Anything else about an already-resolved dispute is a retry, not a refusal:
 * re-asking for the *same* decision whose refund is unfinished is the one thing
 * that endpoint exists to do, and it is safe by construction because every
 * refund is keyed on `refund:<matchId>:<role>`.
 */
export const RESOLUTION_REFUSALS = {
  decided_differently: 'that dispute was already resolved differently',
  refund_complete: 'that dispute is already resolved and its refund is complete',
} as const

export type ResolutionRefusal = keyof typeof RESOLUTION_REFUSALS

/** What a POST to the resolve route may do, given the row as it now stands. */
export type ResolutionDisposition =
  /** Nobody has decided yet: claim the row and pay out. */
  | { act: 'decide' }
  /** The same decision, with money it never managed to return. Ask again. */
  | { act: 'retry' }
  | { act: 'refuse'; reason: ResolutionRefusal }

/**
 * The part of a stored dispute that decides what a second POST may do.
 *
 * A structural type rather than `DisputeRecord`, so the rule stays in `shared/`
 * and testable without a D1 binding — the same reason `refundedRoles` lives
 * here rather than next to the SQL that reads it.
 */
export interface DecidedDispute {
  resolvedAt: number | null
  resolution: DisputeResolution | null
  /**
   * Integer cents this resolution promised to return and has not, as of the
   * last refund attempt Stripe answered. `null` means no attempt has been
   * answered for at all, which is not `0` — the same rule `refunded_cents`
   * follows, and the state a resolution whose refund call failed is left in.
   */
  outstandingCents: number | null
}

/**
 * Decide whether a resolution POST is a decision, a retry, or a refusal.
 *
 * The distinction this exists to draw: a `409` on an already-resolved dispute
 * was blocking a second *attempt* at the same decision as though it were a
 * second *decision* (#103). A resolution whose refund Stripe declined, or whose
 * refund call never completed, left money held with no way back through the API
 * — which is the one thing the route is there for.
 *
 * `outstandingCents` is what makes the question answerable from the row alone.
 * Comparing `refunded_cents` against `held_cents` cannot do it: `settled`
 * refunds nobody and would read as forever unfinished, and `refund_orderer`
 * pays back one half of money that is still holding the other.
 */
export function resolutionDisposition(
  decided: DecidedDispute,
  asked: DisputeResolution,
): ResolutionDisposition {
  if (decided.resolvedAt === null) return { act: 'decide' }
  // Fail closed on a resolved row whose decision cannot be read: a decision
  // nobody can name is not one to overwrite on the strength of a request body.
  if (decided.resolution !== asked) return { act: 'refuse', reason: 'decided_differently' }
  if (decided.outstandingCents !== null && decided.outstandingCents <= 0) {
    return { act: 'refuse', reason: 'refund_complete' }
  }
  return { act: 'retry' }
}

/** Room for an operator to say what they found out. Not a case file. */
export const MAX_DISPUTE_NOTE = 280

/**
 * Clean an operator's note before it is stored and handed back.
 *
 * Through `sanitizeDisplayText` like every other piece of untrusted display text
 * in this repo — an operator is more trusted than a stranger in the pool, and
 * that is still not a reason to keep a second sanitizer. Empty means no note,
 * which is stored as NULL rather than as a blank string.
 */
export function disputeNote(raw: unknown): string | null {
  const cleaned = sanitizeDisplayText(raw, MAX_DISPUTE_NOTE)
  return cleaned.length === 0 ? null : cleaned
}

/**
 * What the Worker asks the Durable Object to do about a resolved dispute's
 * money.
 *
 * A resolution, never a list of roles: the instruction that crosses this
 * boundary should be the decision an operator made, not an already-expanded set
 * of refunds a caller could have expanded wrongly. The object expands it itself
 * with `refundedRoles` above.
 */
export interface DisputeRefundRequest {
  matchId: string
  resolution: DisputeResolution
}

/**
 * Narrow that request, rather than casting it.
 *
 * It crosses a request boundary that a Durable Object stub is not the only way
 * to reach, so it follows the same rule as `parsePaymentOutcome` and the
 * WebSocket protocol: anything off a wire is hostile.
 */
export function parseDisputeRefundRequest(raw: string): DisputeRefundRequest | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const body = data as Record<string, unknown>

  const { matchId } = body
  if (typeof matchId !== 'string' || matchId.length === 0) return null
  const resolution = parseDisputeResolution(body.resolution)
  if (resolution === null) return null
  return { matchId, resolution }
}

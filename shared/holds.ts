/**
 * Money a dead match is still holding, when the teardown was *not* a dispute.
 *
 * A dispute holds money on purpose and `shared/disputes.ts` describes what an
 * operator may decide about it. This describes the other case, which nobody
 * decided: every non-dispute teardown asks Stripe for a refund, and a refund
 * Stripe refuses leaves cents sitting in the account with no human in the loop
 * and — before this existed — no record outside one Durable Object's storage.
 *
 * The two are deliberately parallel rather than one thing: a dispute is a
 * *decision* somebody owes an answer to, and a hold is a *failure* somebody owes
 * a retry to. Folding them together would make "what did we decide?" and "what
 * did the processor refuse?" the same column, and only one of them is a
 * judgement call.
 *
 * Runtime-free, like everything in `shared/`.
 */

/**
 * How a match died, for every teardown that is not a dispute.
 *
 * Named after the message the buyers were actually sent (`match_expired`,
 * `buddy_left`) or the error they were shown (`payment_unavailable`,
 * `payment_failed`), so a row read six months later lines up with what the two
 * people on the other end saw happen. `test/holds.test.ts` enumerates the whole
 * set against `worker/pool.ts`, so a fifth teardown path fails the build rather
 * than retiring a match whose money nothing records.
 */
export const HOLD_REASONS = [
  'match_expired',
  'payment_unavailable',
  'buddy_left',
  'payment_failed',
] as const

export type HoldReason = (typeof HOLD_REASONS)[number]

/**
 * Narrow a reason, rather than casting one.
 *
 * Used as a *gate* as well as a parser: `retireMatch` files a hold only for a
 * teardown this answers, which is what keeps a settled split and a dispute —
 * whose money is already answered for elsewhere — out of the holds table
 * without a second condition anybody could forget to update.
 */
export function parseHoldReason(raw: unknown): HoldReason | null {
  return HOLD_REASONS.includes(raw as HoldReason) ? (raw as HoldReason) : null
}

/**
 * What the Worker asks the Durable Object to do about a hold: try again.
 *
 * There is nothing to decide, so there is nothing else in it. Every refund is
 * keyed on `refundIdempotencyKey`, which is what makes re-asking safe any number
 * of times — a retry that Stripe already honoured refunds nothing a second time.
 */
export interface HoldRetryRequest {
  matchId: string
}

/**
 * Narrow that request rather than casting it.
 *
 * Same rule as `parseDisputeRefundRequest` and `parsePaymentOutcome`: it crosses
 * a request boundary a Durable Object stub is not the only way to reach, so
 * anything off a wire is hostile.
 */
export function parseHoldRetryRequest(raw: string): HoldRetryRequest | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { matchId } = data as Record<string, unknown>
  if (typeof matchId !== 'string' || matchId.length === 0) return null
  return { matchId }
}

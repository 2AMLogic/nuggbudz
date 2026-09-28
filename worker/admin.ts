import { Hono } from 'hono'
import {
  type DisputeResolution,
  disputeNote,
  parseDisputeResolution,
  refundedRoles,
} from '../shared/disputes'
import { isOperator, parseOperatorIds } from '../shared/operators'
import { sessionFromRequest } from './auth'
import type { Env } from './env'
import {
  claimDispute,
  getDispute,
  getHold,
  listDisputes,
  listHolds,
  stampDisputeRefund,
  stampHoldRefund,
} from './ledger'
import { INTERNAL_DISPUTE_PATH, INTERNAL_HOLD_PATH } from './pool'

/**
 * The operator surface: list disputed pickups and resolve one; list money a
 * teardown could not give back, and try again.
 *
 * Everything else in this app is written for two strangers at a counter. This is
 * written for the one person who has to answer for the money when the counter
 * did not happen — a dispute holds $8.98 that is deliberately never refunded
 * automatically (see the README), and a hold nobody can release is just a
 * slower way of keeping it.
 *
 * The two queues are parallel and never mixed. A dispute is a decision somebody
 * owes an answer to; a hold is a refund the processor refused, which nobody
 * decided and which has nothing to resolve — only something to retry.
 *
 * Authorization is a **session plus an allowlist**, not a shared bearer token.
 * A resolution moves money and the row it writes records `resolved_by`; a token
 * can only ever record "whoever had the token", and cannot be revoked without a
 * redeploy. `shared/operators.ts` holds the rule, `OPERATOR_USER_IDS` holds the
 * list, and an unset var means there are no operators at all rather than open
 * routes — the fail-closed direction, as with every other gate here.
 */
export const adminRoutes = new Hono<{ Bindings: Env }>()

/**
 * Resolve the caller, or explain nothing.
 *
 * A caller who is not an operator gets the same 404 the `/api/*` catch-all
 * gives, byte for byte: a signed-in buyer poking at `/api/admin/*` learns
 * whether the route exists from a 401 or a 403, and there is no reason to tell
 * them. The refusal is logged instead, where the people who can act on it are.
 */
async function operatorOf(
  env: Env,
  request: Request,
): Promise<{ userId: string; displayName: string } | null> {
  const active = await sessionFromRequest(env, request)
  if (active === null) return null
  const allowlist = parseOperatorIds(env.OPERATOR_USER_IDS)
  if (!isOperator(active.session.userId, allowlist)) {
    console.warn(
      'admin: refusing %s — not in OPERATOR_USER_IDS (%d configured)',
      active.session.userId,
      allowlist.length,
    )
    return null
  }
  return { userId: active.session.userId, displayName: active.session.displayName }
}

/** The answer a non-operator gets, identical to the API's own 404. */
const notFound = { error: 'not found' } as const

adminRoutes.get('/disputes', async (c) => {
  const operator = await operatorOf(c.env, c.req.raw)
  if (operator === null) return c.json(notFound, 404)

  // Open by default: the queue is the question an operator is here to ask.
  // `state=all` is how a past decision is audited, which is the other one.
  const openOnly = c.req.query('state') !== 'all'
  const rawLimit = c.req.query('limit')
  const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10)
  if (limit !== undefined && !Number.isInteger(limit)) {
    return c.json({ error: 'limit must be an integer' }, 400)
  }

  const disputes = await listDisputes(c.env.DB, {
    openOnly,
    ...(limit === undefined ? {} : { limit }),
  })
  return c.json({ disputes, openOnly })
})

adminRoutes.post('/disputes/:matchId/resolve', async (c) => {
  const operator = await operatorOf(c.env, c.req.raw)
  if (operator === null) return c.json(notFound, 404)

  const body: unknown = await c.req.json().catch(() => null)
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const resolution = parseDisputeResolution(fields.resolution)
  if (resolution === null) {
    // Says what is allowed rather than repeating what arrived — an unvalidated
    // string is not something to echo, the same rule the sauce route follows.
    return c.json(
      { error: 'resolution must be one of settled, voided, refund_orderer, refund_receiver' },
      400,
    )
  }

  const matchId = c.req.param('matchId')
  const existing = await getDispute(c.env.DB, matchId)
  if (existing === null) return c.json(notFound, 404)
  if (existing.resolvedAt !== null) {
    return c.json({ error: 'that dispute is already resolved', dispute: existing }, 409)
  }

  // The claim is the concurrency control, not the read above: two operators
  // deciding at once both reach here and exactly one of them changes a row.
  const claimed = await claimDispute(c.env.DB, {
    matchId,
    resolution,
    // Off the session. A body may say what to decide, never who decided.
    resolvedBy: operator.userId,
    resolvedAt: Date.now(),
    note: disputeNote(fields.note),
  })
  if (!claimed) {
    return c.json({ error: 'that dispute is already resolved' }, 409)
  }

  const money = await settleResolution(
    c.env,
    existing.cell,
    matchId,
    resolution,
    existing.heldCents,
  )
  if (money === null) {
    // The decision stands and the money did not move. `refunded_cents` stays
    // NULL, which is exactly the state this reports: a resolution nobody has
    // finished paying out. Saying 0 here would claim the refund came back empty.
    return c.json(
      { error: 'the resolution was recorded but its refund could not be issued', matchId },
      502,
    )
  }

  await stampDisputeRefund(c.env.DB, matchId, money.refundedCents)
  const dispute = await getDispute(c.env.DB, matchId)
  return c.json({ dispute, refundedCents: money.refundedCents, heldCents: money.heldCents })
})

/**
 * Every match still holding money from a teardown nobody disputed.
 *
 * The question this route exists to answer could not be asked before it: a
 * refused refund left cents in one Durable Object's storage, there is no
 * registry of live cells to fan out to, and nothing in D1 recorded that the
 * money was stuck. This reads a table instead, so it is one query across every
 * cell the app has ever used.
 */
adminRoutes.get('/holds', async (c) => {
  const operator = await operatorOf(c.env, c.req.raw)
  if (operator === null) return c.json(notFound, 404)

  // Open by default, exactly like the disputes queue: "what money is still
  // stuck" is the question, and `state=all` is how a closed one is audited.
  const openOnly = c.req.query('state') !== 'all'
  const rawLimit = c.req.query('limit')
  const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10)
  if (limit !== undefined && !Number.isInteger(limit)) {
    return c.json({ error: 'limit must be an integer' }, 400)
  }

  const holds = await listHolds(c.env.DB, {
    openOnly,
    ...(limit === undefined ? {} : { limit }),
  })
  return c.json({ holds, openOnly })
})

/**
 * Ask the cell that owns the charges to try the refund again.
 *
 * No claim step, unlike a resolution: there is nothing to decide and nothing
 * one operator can take from another. Two people retrying the same hold at once
 * both reach the Durable Object, which processes one event at a time, and the
 * second finds every leg the first recovered already stamped `refunded` — so it
 * asks Stripe for nothing and adds nothing to `refunded_cents`.
 */
adminRoutes.post('/holds/:matchId/retry', async (c) => {
  const operator = await operatorOf(c.env, c.req.raw)
  if (operator === null) return c.json(notFound, 404)

  const matchId = c.req.param('matchId')
  const existing = await getHold(c.env.DB, matchId)
  if (existing === null) return c.json(notFound, 404)
  if (existing.releasedAt !== null) {
    return c.json({ error: 'that hold is already released', hold: existing }, 409)
  }

  const money = await retryHold(c.env, existing.cell, matchId)
  if (money === null) {
    // Nothing moved and nothing is claimed to have. The row is left exactly as
    // it was — `refunded_cents` untouched, still open — because a retry that
    // could not be attempted is not a retry that came back empty.
    return c.json({ error: 'the refund could not be re-attempted', matchId }, 502)
  }

  // Only now, after Stripe has answered: the same rule `stampDisputeRefund`
  // follows, and the reason a leg whose refund failed stays `succeeded`.
  await stampHoldRefund(c.env.DB, matchId, {
    refundedCents: money.refundedCents,
    heldCents: money.heldCents,
    retriedAt: Date.now(),
  })
  const hold = await getHold(c.env.DB, matchId)
  return c.json({ hold, refundedCents: money.refundedCents, heldCents: money.heldCents })
})

/**
 * Re-attempt a hold's refund, in the cell that owns the charges.
 *
 * Returns null when the cell could not be asked at all, which the caller turns
 * into a 502 and an untouched row rather than a stamp claiming a refund that
 * was never answered for.
 */
async function retryHold(
  env: Env,
  cell: string,
  matchId: string,
): Promise<{ refundedCents: number; heldCents: number } | null> {
  const stub = env.NUGG_POOL.get(env.NUGG_POOL.idFromName(cell))
  const response = await stub.fetch(
    new Request(`https://nugg-pool.internal${INTERNAL_HOLD_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ matchId }),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  if (!response.ok) return null
  const result = (await response.json()) as { refundedCents?: unknown; heldCents?: unknown }
  if (typeof result.refundedCents !== 'number' || typeof result.heldCents !== 'number') return null
  return { refundedCents: result.refundedCents, heldCents: result.heldCents }
}

/**
 * Carry out the money half of a resolution, in the cell that owns the charges.
 *
 * Returns null when the refund could not be attempted at all, which the caller
 * turns into a resolved dispute with an unanswered refund rather than a lie
 * about one. A resolution that refunds nobody, or a dispute that was holding
 * nothing, never leaves the Worker: there is no processor call to make.
 */
async function settleResolution(
  env: Env,
  cell: string,
  matchId: string,
  resolution: DisputeResolution,
  heldCents: number,
): Promise<{ refundedCents: number; heldCents: number } | null> {
  if (refundedRoles(resolution).length === 0 || heldCents === 0) {
    return { refundedCents: 0, heldCents }
  }

  const stub = env.NUGG_POOL.get(env.NUGG_POOL.idFromName(cell))
  const response = await stub.fetch(
    new Request(`https://nugg-pool.internal${INTERNAL_DISPUTE_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ matchId, resolution }),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  if (!response.ok) return null
  const result = (await response.json()) as { refundedCents?: unknown; heldCents?: unknown }
  if (typeof result.refundedCents !== 'number' || typeof result.heldCents !== 'number') return null
  return { refundedCents: result.refundedCents, heldCents: result.heldCents }
}

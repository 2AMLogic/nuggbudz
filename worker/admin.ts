import { Hono } from 'hono'
import {
  type DisputeResolution,
  disputeNote,
  parseDisputeResolution,
  RESOLUTION_REFUSALS,
  type ResolutionRefusal,
  refundedRoles,
  resolutionDisposition,
} from '../shared/disputes'
import { isOperator, parseOperatorIds } from '../shared/operators'
import { sessionFromRequest } from './auth'
import type { Env } from './env'
import { listHoneypotSignals } from './honeypot'
import {
  claimDispute,
  type DisputeRecord,
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
 * A dispute can need both. The decision is made once and is not overturnable
 * here, but the refund it implies can fail like any other, and re-POSTing the
 * *same* resolution is how it is asked for again — which is why a resolved
 * dispute is not automatically a closed one (#103). A hold is still never filed
 * for it: the money is already in one operator queue, and putting it in two is
 * worse than leaving it in one.
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

  // A resolved dispute is not automatically a closed one. The 409 below exists
  // to stop a second *decision*; re-asking for the decision already stored,
  // because its refund never came back, is a second *attempt* at the same one —
  // and the only route there is to release that money (#103).
  const disposition = resolutionDisposition(existing, resolution)
  if (disposition.act === 'refuse') return c.json(refusal(disposition.reason, existing), 409)

  if (disposition.act === 'decide') {
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
      // Somebody decided in the gap. Whether this caller may still push the
      // money along is the same question asked of the row as it now stands: an
      // identical decision is a retry, anything else is an overturn.
      const decided = await getDispute(c.env.DB, matchId)
      const after = decided === null ? null : resolutionDisposition(decided, resolution)
      if (after?.act !== 'retry') {
        const reason = after?.act === 'refuse' ? after.reason : 'decided_differently'
        return c.json(refusal(reason, decided ?? existing), 409)
      }
    }
  }
  // A retry deliberately claims nothing and rewrites nothing: `resolved_by`,
  // `resolved_at`, `resolution` and the note are the decision, it stands, and
  // this caller is only finishing paying it out. Two retries at once are safe
  // for the reason the holds queue needs no claim either — the object refunds
  // one event at a time, every refund is keyed `refund:<matchId>:<role>`, and
  // the second finds nothing left owed.

  const money = await settleResolution(
    c.env,
    existing.cell,
    matchId,
    resolution,
    existing.heldCents,
  )
  if (money === null) {
    // The decision stands and the money did not move. `refunded_cents` and
    // `outstanding_cents` stay NULL, which is exactly the state this reports: a
    // resolution nobody has finished paying out. Saying 0 would claim the refund
    // came back empty. POSTing the same resolution again is the way out.
    return c.json(
      {
        error: 'the resolution was recorded but its refund could not be issued',
        reason: 'refund_unattempted',
        retry: 'POST the same resolution again',
        matchId,
      },
      502,
    )
  }

  await stampDisputeRefund(c.env.DB, matchId, {
    refundedCents: money.refundedCents,
    outstandingCents: money.outstandingCents,
  })
  const dispute = await getDispute(c.env.DB, matchId)
  return c.json({
    dispute,
    refundedCents: money.refundedCents,
    heldCents: money.heldCents,
    // What this resolution still owes. Greater than zero is an operator's cue
    // to POST the same resolution again once whatever Stripe objected to is
    // dealt with, and it is the same figure the next POST is judged against.
    outstandingCents: money.outstandingCents,
  })
})

/**
 * Say no to a resolution POST, and say which no it is.
 *
 * Both refusals are 409s and an operator cannot act on either without knowing
 * which: one means a colleague already decided something else, the other means
 * there is genuinely nothing left to do. Before #103 they were the same sentence
 * — and one of them was wrong, because a resolution whose refund failed was
 * being refused as though it had succeeded.
 */
function refusal(
  reason: ResolutionRefusal,
  dispute: DisputeRecord,
): { error: string; reason: ResolutionRefusal; dispute: DisputeRecord } {
  return { error: RESOLUTION_REFUSALS[reason], reason, dispute }
}

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
 * What decoy buyers have seen lately — the abuse tripwire's queue.
 *
 * Read-only, and there is deliberately no action endpoint beside it. A dispute
 * is a decision somebody owes an answer to and a hold is a refund somebody owes
 * a retry to; a honeypot signal is neither. It is an *observation*: this caller
 * flooded a decoy's chat, or tried pickup codes against a match that never had
 * one — behaviours no legitimate client produces, which is the only reason they
 * are recorded at all.
 *
 * What a human does with it, stated here because a tripwire nobody reads is not
 * one: check it when a market looks wrong, and read three things off it. An
 * empty list is the normal answer and is itself informative. A handful of rows
 * from many `actorUserId`s is noise — clients retrying, somebody mashing a
 * button. A run of rows from **one** `actorUserId`, or one `cell`, inside a
 * short window is the thing this exists to surface, and the action it calls for
 * lives outside this app: revoke that account's sessions, or ask the operator
 * who owns the deployment to rate-limit that caller at the edge. Narrow to one
 * caller with `?actor=<users.id>` and to a window with `?sinceMs=<epoch>`.
 *
 * No chat content is here, by construction — see `migrations/0008`. What was
 * said is not stored anywhere, and the tripwire is not an exception to that.
 */
adminRoutes.get('/honeypot', async (c) => {
  const operator = await operatorOf(c.env, c.req.raw)
  if (operator === null) return c.json(notFound, 404)

  const rawLimit = c.req.query('limit')
  const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10)
  if (limit !== undefined && !Number.isInteger(limit)) {
    return c.json({ error: 'limit must be an integer' }, 400)
  }
  const rawSince = c.req.query('sinceMs')
  const sinceMs = rawSince === undefined ? undefined : Number.parseInt(rawSince, 10)
  if (sinceMs !== undefined && !Number.isInteger(sinceMs)) {
    return c.json({ error: 'sinceMs must be an integer' }, 400)
  }
  const actorUserId = c.req.query('actor')

  const signals = await listHoneypotSignals(c.env.DB, {
    ...(limit === undefined ? {} : { limit }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(actorUserId === undefined ? {} : { actorUserId }),
  })
  return c.json({ signals })
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
 * about one — and, since #103, one a second POST of the same resolution can
 * finish. A resolution that refunds nobody, or a dispute that was holding
 * nothing, never leaves the Worker: there is no processor call to make.
 */
async function settleResolution(
  env: Env,
  cell: string,
  matchId: string,
  resolution: DisputeResolution,
  heldCents: number,
): Promise<{ refundedCents: number; heldCents: number; outstandingCents: number } | null> {
  if (refundedRoles(resolution).length === 0 || heldCents === 0) {
    // Nothing was ever owed, so nothing is outstanding and there is nothing to
    // retry: `settled` holds both halves on purpose, and a dispute holding
    // nothing has no legs to refund.
    return { refundedCents: 0, heldCents, outstandingCents: 0 }
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
  const result = (await response.json()) as {
    refundedCents?: unknown
    heldCents?: unknown
    outstandingCents?: unknown
  }
  if (typeof result.refundedCents !== 'number' || typeof result.heldCents !== 'number') return null
  // A body that does not say what is still owed is the 502 path, not a zero: a
  // refund stamped as finished is the one state there is no way back from.
  if (typeof result.outstandingCents !== 'number') return null
  return {
    refundedCents: result.refundedCents,
    heldCents: result.heldCents,
    outstandingCents: result.outstandingCents,
  }
}

/**
 * The D1 side of the honeypot tripwire: where a signal lands, and how it is read.
 *
 * `shared/honeypot.ts` owns what a decoy *is* and what counts as a signal; this
 * owns where a signal lives. The split is the same one `worker/reputation.ts`
 * makes, and for the same reason: the Durable Object is the only thing that sees
 * the behaviour, and D1 is the only thing that remembers it after the cell is
 * evicted.
 *
 * **A signal carries no chat content.** Which match, which decoy, which caller,
 * which kind, when — and nothing else. Nuggchat is relayed and never stored, and
 * a tripwire watching that channel must not be the thing that starts storing it.
 */
import { type HoneypotSignalKind, parseHoneypotSignal } from '../shared/honeypot'
import { classifyUserId } from '../shared/identity'

/** One thing a decoy saw, as it is recorded. */
export interface HoneypotSignal {
  matchId: string
  cell: string
  /** The decoy's own id — `honeypot:<uuid>`. */
  honeypotUserId: string
  /** Whoever did it: an account, or a `demo:` identity on a demo deployment. */
  actorUserId: string
  kind: HoneypotSignalKind
  observedAt: number
}

export interface HoneypotStatement {
  sql: string
  params: (string | number)[]
}

const INSERT_SIGNAL = `INSERT INTO honeypot_signals
  (match_id, cell, honeypot_user_id, actor_user_id, kind, observed_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)`

/**
 * The row one observation becomes, or nothing.
 *
 * Shaped separately from the write so it is testable without a D1 binding,
 * exactly as `ledgerStatements` and `reputationStatements` are.
 *
 * Nothing is recorded about a caller whose id names nobody: an `unauthentic` id
 * cannot have done anything, because no socket carrying one is ever seated. A
 * row naming `''` would be an entry in an abuse queue that a human can neither
 * act on nor rule out, which is worse than no row — and this is the one gate
 * that keeps the queue worth reading.
 *
 * The kind is re-parsed rather than trusted, so a caller cannot widen the
 * `CHECK` constraint by handing this a string.
 */
export function honeypotSignalStatements(signal: HoneypotSignal): HoneypotStatement[] {
  const kind = parseHoneypotSignal(signal.kind)
  if (kind === null) return []
  if (classifyUserId(signal.actorUserId) === 'unauthentic') return []
  if (signal.matchId.length === 0 || signal.honeypotUserId.length === 0) return []
  return [
    {
      sql: INSERT_SIGNAL,
      params: [
        signal.matchId,
        signal.cell,
        signal.honeypotUserId,
        signal.actorUserId,
        kind,
        signal.observedAt,
      ],
    },
  ]
}

/**
 * Record what a decoy saw.
 *
 * Not retried, like `recordReputation` and unlike the ledger: an observation
 * that is occasionally missing is a slightly quieter queue, while a retried
 * insert (there is no `OR IGNORE` to lean on — every row is distinct by
 * construction) would double-count a flood and make the queue read worse than
 * empty. Throws on a D1 failure; the caller in `worker/pool.ts` logs and
 * continues, because a tripwire must never be the thing that breaks a handoff.
 */
export async function recordHoneypotSignal(db: D1Database, signal: HoneypotSignal): Promise<void> {
  const statements = honeypotSignalStatements(signal)
  if (statements.length === 0) return
  await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
}

/** How many signals one listing hands back, however large a `limit` is asked for. */
export const MAX_SIGNAL_PAGE = 200

interface SignalRow {
  match_id: string
  cell: string
  honeypot_user_id: string
  actor_user_id: string
  kind: string
  observed_at: number
}

/** One signal as an operator sees it. */
export interface HoneypotSignalRecord {
  matchId: string
  cell: string
  honeypotUserId: string
  actorUserId: string
  kind: string
  observedAt: number
}

/**
 * What decoys have seen lately, newest first.
 *
 * There is no `state` and no resolution: a signal is an observation, not a case.
 * The question an operator is here to ask is "is anything hammering a market,
 * and since when", and the answer is a list in time order — including the empty
 * list, which is the answer most of the time and is worth being able to see.
 */
export async function listHoneypotSignals(
  db: D1Database,
  options: { actorUserId?: string; sinceMs?: number; limit?: number } = {},
): Promise<HoneypotSignalRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? MAX_SIGNAL_PAGE, 1), MAX_SIGNAL_PAGE)
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (options.actorUserId !== undefined && options.actorUserId.length > 0) {
    params.push(options.actorUserId)
    clauses.push(`actor_user_id = ?${params.length}`)
  }
  if (options.sinceMs !== undefined && Number.isFinite(options.sinceMs)) {
    params.push(options.sinceMs)
    clauses.push(`observed_at >= ?${params.length}`)
  }
  params.push(limit)
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  const { results } = await db
    .prepare(
      `SELECT match_id, cell, honeypot_user_id, actor_user_id, kind, observed_at
         FROM honeypot_signals ${where}
        ORDER BY observed_at DESC LIMIT ?${params.length}`,
    )
    .bind(...params)
    .all<SignalRow>()

  return results.map((row) => ({
    matchId: row.match_id,
    cell: row.cell,
    honeypotUserId: row.honeypot_user_id,
    actorUserId: row.actor_user_id,
    kind: row.kind,
    observedAt: row.observed_at,
  }))
}

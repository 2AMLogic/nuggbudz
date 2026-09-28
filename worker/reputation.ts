/**
 * The D1 side of buddy standing: the counters, and the band read back out.
 *
 * `shared/reputation.ts` owns what the counters *mean*; this owns where they live.
 * The split matters because the Durable Object is the only thing that knows a
 * handoff finished, and D1 is the only thing that remembers it afterwards — a
 * cell can be evicted from memory between the lunch and dinner rushes, so live
 * state cannot hold a buyer's history.
 */
import { classifyUserId } from '../shared/identity'
import { type ReputationCounts, type StandingBand, standingBand } from '../shared/reputation'

/** What a match can say about one buyer. One column each. */
export type ReputationEvent = 'completed' | 'no_show' | 'late_cancel'

export interface ReputationUpdate {
  userId: string
  event: ReputationEvent
}

export interface ReputationStatement {
  sql: string
  params: (string | number)[]
}

/**
 * Increment one of the three counters, creating the row on first sight.
 *
 * The event picks which of three bound `1`/`0` values lands, so the column name
 * is never interpolated into SQL. The `user_reputation.` qualifier on the right
 * of each assignment is load-bearing: unqualified it would still mean the stored
 * row in SQLite, but "old value plus new value" is the whole point of the
 * statement and is worth being unambiguous about.
 */
const BUMP = `INSERT INTO user_reputation
  (user_id, splits_completed, no_shows, late_cancels, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (user_id) DO UPDATE SET
    splits_completed = user_reputation.splits_completed + excluded.splits_completed,
    no_shows = user_reputation.no_shows + excluded.no_shows,
    late_cancels = user_reputation.late_cancels + excluded.late_cancels,
    updated_at = excluded.updated_at`

/**
 * The rows a set of match outcomes becomes.
 *
 * Split out from the database call so the shape of the write is testable without
 * a D1 binding, exactly as `ledgerStatements` is.
 *
 * Only accounts are counted. A demo pairing mints a throwaway `demo:` identity
 * that has no `users` row behind it, so the foreign key would refuse the write
 * anyway — dropping it here means a stage demo runs the whole handshake without
 * a failed statement in the log. An id that is neither is dropped for the same
 * reason and, unlike the ledger, without throwing: nothing is being booked, so
 * there is no wrong number to prevent, and a reputation bug must never be the
 * thing that strands two people who already swapped nuggets.
 */
export function reputationStatements(
  updates: readonly ReputationUpdate[],
  now: number,
): ReputationStatement[] {
  const statements: ReputationStatement[] = []
  for (const { userId, event } of updates) {
    if (classifyUserId(userId) !== 'account') continue
    statements.push({
      sql: BUMP,
      params: [
        userId,
        event === 'completed' ? 1 : 0,
        event === 'no_show' ? 1 : 0,
        event === 'late_cancel' ? 1 : 0,
        now,
      ],
    })
  }
  return statements
}

/**
 * Record what a match said about its buyers.
 *
 * Deliberately not retried, which is the one place this departs from the ledger.
 * The ledger's statements are `INSERT OR IGNORE`, so replaying a partly-applied
 * batch cannot double-book; these are increments, so replaying one would count a
 * handoff twice. A counter that is occasionally one short is a band that is
 * occasionally generous, and that is a much better failure than a no-show
 * invented by a retry.
 *
 * Throws on a D1 failure. The caller in `worker/pool.ts` logs and continues:
 * standing is a courtesy, and no part of the handoff depends on it.
 */
export async function recordReputation(
  db: D1Database,
  updates: readonly ReputationUpdate[],
  now: number = Date.now(),
): Promise<void> {
  const statements = reputationStatements(updates, now)
  if (statements.length === 0) return
  await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
}

interface StoredCounts {
  user_id: string
  splits_completed: number
  no_shows: number
  late_cancels: number
}

/**
 * The bands for a set of buyers, in one round trip.
 *
 * One query rather than one per buyer because the caller is the pairing path: a
 * join scans everyone waiting in the cell, and that must not become N reads. Ids
 * that are not accounts are not asked about at all — they have no row by
 * construction — and an account with no row yet is simply absent from the result,
 * which callers read as `new`.
 *
 * Counts are reduced to a band here, at the boundary, so no caller above this
 * line is ever holding a number it could leak.
 */
export async function readStandings(
  db: D1Database,
  userIds: readonly string[],
): Promise<Map<string, StandingBand>> {
  const wanted = [...new Set(userIds.filter((id) => classifyUserId(id) === 'account'))]
  const bands = new Map<string, StandingBand>()
  if (wanted.length === 0) return bands

  const placeholders = wanted.map((_, index) => `?${index + 1}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT user_id, splits_completed, no_shows, late_cancels
       FROM user_reputation WHERE user_id IN (${placeholders})`,
    )
    .bind(...wanted)
    .all<StoredCounts>()

  for (const row of results) {
    bands.set(row.user_id, standingBand(countsOf(row)))
  }
  return bands
}

/** One buyer's band, for the callers that only care about one. */
export async function readStanding(db: D1Database, userId: string): Promise<StandingBand> {
  const bands = await readStandings(db, [userId])
  return bands.get(userId) ?? 'new'
}

function countsOf(row: StoredCounts): ReputationCounts {
  return {
    splitsCompleted: row.splits_completed,
    noShows: row.no_shows,
    lateCancels: row.late_cancels,
  }
}

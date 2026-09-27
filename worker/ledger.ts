/**
 * The D1 ledger of settled splits.
 *
 * A match becomes a ledger row at exactly one moment: when both buddies have
 * confirmed the handoff. Anything earlier is live state, which the Durable
 * Object owns; anything unconfirmed is not a split that happened.
 */
import type { BuyerRole, Settlement } from '../shared/economics'

/** Everything the ledger needs to know about one settled split. */
export interface SettledMatch {
  matchId: string
  dealId: string
  /** The geohash cell that matched the pair — the market this split happened in. */
  cell: string
  distanceMeters: number
  createdAt: number
  settledAt: number
  settlement: Settlement
  /** Display names by role, as each buddy saw the other at match time. */
  names: Record<BuyerRole, string>
}

export interface LedgerStatement {
  sql: string
  params: (string | number)[]
}

const INSERT_MATCH = `INSERT OR IGNORE INTO matches (
  match_id, deal_id, cell, party_size, total_collected_cents, cogs_cents,
  platform_fee_cents, distance_meters, created_at, settled_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const INSERT_BUYER = `INSERT OR IGNORE INTO match_buyers (
  match_id, role, display_name, pay_cents, solo_baseline_cents, pieces_owed
) VALUES (?, ?, ?, ?, ?, ?)`

/**
 * The rows one settled split becomes.
 *
 * Split out from the database call so the shape of the write is testable without
 * a D1 binding — every money column here is integer cents taken straight off
 * the settlement, never recomputed.
 */
export function ledgerStatements(match: SettledMatch): LedgerStatement[] {
  const { settlement } = match
  const statements: LedgerStatement[] = [
    {
      // OR IGNORE rather than REPLACE: a settled split is written once, and a
      // retry after a partial failure must not rewrite what was already booked.
      sql: INSERT_MATCH,
      params: [
        match.matchId,
        settlement.dealId,
        match.cell,
        settlement.partySize,
        settlement.totalCollectedCents,
        settlement.cogsCents,
        settlement.platformFeeCents,
        match.distanceMeters,
        match.createdAt,
        match.settledAt,
      ],
    },
  ]

  for (const share of settlement.shares) {
    statements.push({
      sql: INSERT_BUYER,
      params: [
        match.matchId,
        share.role,
        match.names[share.role],
        share.payCents,
        share.soloBaselineCents,
        share.piecesOwed,
      ],
    })
  }

  return statements
}

/** How many times a failed batch is tried before the write is given up on. */
const DEFAULT_MAX_ATTEMPTS = 3

/** Linear backoff base: attempt N waits `retryDelayMs * N`. */
const DEFAULT_RETRY_DELAY_MS = 200

export interface WriteOptions {
  maxAttempts?: number
  retryDelayMs?: number
  /** Injectable so tests exercise the backoff without waiting for it. */
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Book a settled split. Batched, so a match never lands without its buyers.
 *
 * This is the one place money becomes durable: everything upstream is live
 * state the Durable Object owns and can lose safely, and a `matches` row is the
 * only record that a split happened. So a transient D1 failure is retried a
 * bounded number of times with linear backoff rather than costing the row on
 * the first blip. `INSERT OR IGNORE` is what makes replaying safe — a partially
 * applied batch cannot be double-booked by the next attempt.
 *
 * Still throws once the attempts are exhausted. The swallow belongs to exactly
 * one layer, and that layer is `NuggPool.completeMatch`, which must not strand
 * two people who already swapped nuggets; having both retry here and a silent
 * return would leave the caller unable to tell a booked split from a lost one.
 */
export async function writeSettledMatch(
  db: D1Database,
  match: SettledMatch,
  options: WriteOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = options.sleep ?? wait
  const statements = ledgerStatements(match)

  for (let attempt = 1; ; attempt++) {
    try {
      await db.batch(
        statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)),
      )
      return
    } catch (error) {
      if (attempt >= maxAttempts) throw error
      await sleep(retryDelayMs * attempt)
    }
  }
}

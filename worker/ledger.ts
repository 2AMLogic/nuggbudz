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

/** Book a settled split. Batched, so a match never lands without its buyers. */
export async function writeSettledMatch(db: D1Database, match: SettledMatch): Promise<void> {
  const statements = ledgerStatements(match)
  await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
}

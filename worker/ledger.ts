/**
 * The D1 ledger of settled splits.
 *
 * A match becomes a ledger row at exactly one moment: when both buddies have
 * confirmed the handoff. Anything earlier is live state, which the Durable
 * Object owns; anything unconfirmed is not a split that happened.
 */
import { isDemoUserId } from '../shared/demo'
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
  /**
   * Account ids by role, as the Worker minted them at upgrade time.
   *
   * Required, and not written to any column: the ledger needs them only to
   * decide whether this split is real. Making it a required field is the point —
   * a future caller cannot reach the write without stating who settled, so the
   * demo gate below cannot be bypassed by forgetting to pass something.
   */
  userIds: Record<BuyerRole, string>
}

/**
 * Is this a demo pairing rather than a real split?
 *
 * `ALLOW_DEMO_PAIRING` mints throwaway `demo:` identities for unauthenticated
 * sockets so two phones can pair on a stage without Google sign-in. Those pairs
 * run the whole handshake, receipt included, but they are not revenue, and the
 * deck's figures are derived from this ledger — so a stage demo must not be able
 * to book money rows into it. `match_buyers` stores an attacker-chosen
 * `display_name` and no user id, so a booked demo row would be neither
 * distinguishable nor filterable after the fact: the only safe answer is not to
 * write it.
 */
export function isDemoMatch(match: SettledMatch): boolean {
  return Object.values(match.userIds).some((userId) => isDemoUserId(userId))
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
  // The demo gate lives here, at the one place the rows are shaped, rather than
  // at the Durable Object that happens to call it today — a second call site
  // added later inherits it instead of having to remember it.
  if (isDemoMatch(match)) return []

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
  // A demo pairing yields no statements: nothing to book, and no empty batch.
  if (statements.length === 0) return
  await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
}

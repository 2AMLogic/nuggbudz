import type { BuyerRole, Settlement } from '../shared/economics'

/** One buyer's identity at settlement time — just enough to write a ledger row. */
export interface SettledBuyer {
  role: BuyerRole
  displayName: string
}

export interface SettledMatch {
  matchId: string
  dealId: string
  /** Geohash cell this match happened in — the shard key every geographic report groups by. */
  cell: string
  createdAt: number
  settledAt: number
  distanceMeters: number
  settlement: Settlement
  buyers: SettledBuyer[]
}

export interface RecordSettledMatchOptions {
  maxAttempts?: number
  retryDelayMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 200

/**
 * Write one settled split to the D1 ledger: one `matches` row and one
 * `match_buyers` row per buyer.
 *
 * Both statements run in a single `DB.batch` so a partial write can never
 * leave a match without its buyers. `INSERT OR IGNORE` makes the write
 * idempotent on `match_id` / `(match_id, role)` — replaying the same match,
 * whether from our own retry below or a future caller resending after a
 * crash, never duplicates rows.
 *
 * A D1 failure is retried a bounded number of times and, if it still fails,
 * logged and swallowed rather than thrown: the pairing already happened over
 * the socket, and the ledger catching up late is better than the live match
 * breaking because reporting did.
 */
export async function recordSettledMatch(
  db: D1Database,
  match: SettledMatch,
  options: RecordSettledMatchOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const statements = buildStatements(db, match)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.batch(statements)
      return
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error(
          `ledger: failed to record match ${match.matchId} after ${maxAttempts} attempt(s)`,
          err,
        )
        return
      }
      await sleep(retryDelayMs * attempt)
    }
  }
}

function buildStatements(db: D1Database, match: SettledMatch): D1PreparedStatement[] {
  const { settlement } = match

  const matchStatement = db
    .prepare(
      `INSERT OR IGNORE INTO matches
         (match_id, deal_id, cell, party_size, total_collected_cents, cogs_cents,
          platform_fee_cents, distance_meters, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      match.matchId,
      match.dealId,
      match.cell,
      settlement.partySize,
      settlement.totalCollectedCents,
      settlement.cogsCents,
      settlement.platformFeeCents,
      match.distanceMeters,
      match.createdAt,
      match.settledAt,
    )

  const buyerStatements = match.buyers.map((buyer) => {
    // Matched by role rather than array position: settlement.shares happens to
    // put the orderer first, but nothing here should depend on that holding.
    const share = settlement.shares.find((s) => s.role === buyer.role)
    if (share === undefined) {
      throw new Error(
        `ledger: no settlement share for role ${buyer.role} in match ${match.matchId}`,
      )
    }
    return db
      .prepare(
        `INSERT OR IGNORE INTO match_buyers
           (match_id, role, display_name, pay_cents, solo_baseline_cents, pieces_owed)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        match.matchId,
        buyer.role,
        buyer.displayName,
        share.payCents,
        share.soloBaselineCents,
        share.piecesOwed,
      )
  })

  return [matchStatement, ...buyerStatements]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

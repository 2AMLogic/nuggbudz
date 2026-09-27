import type { BuyerShare, Settlement } from '../shared/economics'

/** Everything needed to write one settled split into the D1 ledger. */
export interface SettledMatchRecord {
  matchId: string
  dealId: string
  /** Geohash cell the match happened in — the shard key every report groups by. */
  cell: string
  settlement: Settlement
  distanceMeters: number
  createdAt: number
  settledAt: number
  ordererName: string
  receiverName: string
}

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 200

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Write one settled match to the D1 ledger: one `matches` row and one
 * `match_buyers` row per buyer, in a single `batch` so a partial write can
 * never leave a match without its buyers.
 *
 * `INSERT OR IGNORE` makes the write idempotent on `match_id` / `(match_id,
 * role)` — both already primary keys — so a retry (ours, or a future
 * pickup-confirmation retry) is a no-op rather than a duplicate ledger row.
 *
 * A D1 outage must never break the live match: the Durable Object's own state
 * is the source of truth for the match itself, and this is reporting on top of
 * it. A failure here is retried a few times and, failing that, only logged.
 */
export async function writeSettledMatch(db: D1Database, record: SettledMatchRecord): Promise<void> {
  const { settlement } = record
  const [ordererShare, receiverShare] = settlement.shares
  if (ordererShare === undefined || receiverShare === undefined) {
    throw new RangeError(`settlement for match ${record.matchId} does not have two shares`)
  }

  const matchStmt = db
    .prepare(
      `INSERT OR IGNORE INTO matches
        (match_id, deal_id, cell, party_size, total_collected_cents, cogs_cents,
         platform_fee_cents, distance_meters, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.matchId,
      record.dealId,
      record.cell,
      settlement.partySize,
      settlement.totalCollectedCents,
      settlement.cogsCents,
      settlement.platformFeeCents,
      record.distanceMeters,
      record.createdAt,
      record.settledAt,
    )

  const buyerStmt = (share: BuyerShare, displayName: string) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO match_buyers
          (match_id, role, display_name, pay_cents, solo_baseline_cents, pieces_owed)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.matchId,
        share.role,
        displayName,
        share.payCents,
        share.soloBaselineCents,
        share.piecesOwed,
      )

  const statements = [
    matchStmt,
    buyerStmt(ordererShare, record.ordererName),
    buyerStmt(receiverShare, record.receiverName),
  ]

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await db.batch(statements)
      return
    } catch (err) {
      console.error(
        `ledger write failed for match ${record.matchId} (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        err,
      )
      if (attempt === MAX_ATTEMPTS) return
      await delay(RETRY_DELAY_MS * attempt)
    }
  }
}

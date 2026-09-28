/**
 * The D1 ledger of settled splits.
 *
 * A match becomes a ledger row at exactly one moment: when both buddies have
 * confirmed the handoff. Anything earlier is live state, which the Durable
 * Object owns; anything unconfirmed is not a split that happened.
 */
import { isDemoUserId } from '../shared/demo'
import type { BuyerRole, Settlement } from '../shared/economics'
import { classifyUserId } from '../shared/identity'

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
   * decide whether this split is real. Making it a required field is half the
   * point — a future caller cannot reach the write without stating who settled.
   * `assertAuthenticIdentities` below is the other half, because a required
   * field can still be filled with `''`, and the type system cannot tell the
   * difference between a stated identity and a true one.
   */
  userIds: Record<BuyerRole, string>
}

/**
 * The roles a settled split has, in a fixed order.
 *
 * Iterated by name rather than via `Object.keys(match.userIds)` so a role whose
 * id is missing altogether is *checked* rather than skipped — an untyped caller
 * can hand this a half-filled record, and that is exactly the case worth
 * catching.
 */
const SETTLED_ROLES: readonly BuyerRole[] = ['orderer', 'receiver']

/**
 * A split arrived at the ledger carrying an identity that names nobody.
 *
 * Its own class because this is not a D1 problem and retrying cannot help: the
 * write is refused before a single statement is shaped. The one caller,
 * `NuggPool.completeMatch`, already logs and swallows ledger failures so two
 * people who have swapped nuggets are not stranded, which is the right handling
 * here too — the split does not become revenue, and it says so in the log.
 *
 * The offending value is deliberately not in the message: an unauthentic id is
 * by definition not one we minted, so it is untrusted text, and the role is
 * enough to find the bug.
 */
export class UnauthenticIdentityError extends Error {
  readonly role: BuyerRole

  constructor(role: BuyerRole) {
    super(`ledger write refused: the ${role} is neither a real account nor a demo pairing`)
    this.name = 'UnauthenticIdentityError'
    this.role = role
  }
}

/**
 * Refuse a split whose identities could not have been minted by either path.
 *
 * The demo gate below is a prefix test, so before this check `{ orderer: '',
 * receiver: '' }` type-checked, answered `isDemoMatch=false`, and booked a full
 * set of money rows (issue #55). A statement of who settled is only worth
 * anything if the ledger can tell it is true, and the only truth available at
 * this layer is the shape of an id the Worker mints — `classifyUserId`.
 *
 * Throwing rather than returning no statements, which is what a demo pairing
 * gets: booking nothing is the correct, quiet outcome for a handshake working
 * exactly as designed, and the wrong thing to be quiet about when a caller has a
 * bug instead.
 */
function assertAuthenticIdentities(match: SettledMatch): void {
  for (const role of SETTLED_ROLES) {
    if (classifyUserId(match.userIds[role]) === 'unauthentic') {
      throw new UnauthenticIdentityError(role)
    }
  }
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
  // Both gates live here, at the one place the rows are shaped, rather than at
  // the Durable Object that happens to call it today — a second call site added
  // later inherits them instead of having to remember them.
  //
  // Authenticity first: an empty id is not a demo id, so asking the demo
  // question first would answer "not a demo, book it" about an identity that
  // names nobody.
  assertAuthenticIdentities(match)
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
 *
 * Rejects immediately with `UnauthenticIdentityError` for a split whose
 * identities name nobody: the statements are shaped before the loop, so an
 * unauthentic identity never reaches D1 and is never retried — there is nothing
 * transient about it.
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
  // A demo pairing yields no statements. Returning before the retry loop rather
  // than inside it matters: an empty batch that D1 rejected would otherwise be
  // retried with backoff and then thrown, turning "nothing to book" into an
  // error on a path that is working correctly.
  if (statements.length === 0) return

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

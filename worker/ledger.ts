/**
 * What a match leaves behind in D1 once the Durable Object is done with it.
 *
 * Two outcomes reach durable storage, and they are deliberately two tables:
 *
 * - `matches` / `match_buyers` — the ledger of **settled** splits. A match
 *   becomes a row here at exactly one moment: when both buddies have confirmed
 *   the handoff. Anything earlier is live state, which the Durable Object owns;
 *   anything unconfirmed is not a split that happened. Every revenue figure in
 *   this repo is a query over it.
 * - `disputes` — the queue of splits **one** buddy confirmed and the other
 *   never did. Not a weaker settled split and not a row in `matches` with a
 *   flag on it: it is an item of work for a human, holding money that was
 *   collected and deliberately not returned.
 * - `holds` — money a match is still holding after a teardown that was *not* a
 *   dispute, because Stripe refused the refund. Parallel to `disputes` rather
 *   than folded into it: a dispute is a decision somebody owes an answer to,
 *   and a hold is a failure somebody owes a retry to. Nobody decided a hold.
 *
 * Keeping them apart is what lets `/api/stats` stay a plain `WHERE settled_at
 * IS NOT NULL` rather than a filter every future query has to remember.
 */
import { isDemoUserId } from '../shared/demo'
import type { DisputeReason, DisputeResolution } from '../shared/disputes'
import type { BuyerRole, Settlement } from '../shared/economics'
import type { HoldReason } from '../shared/holds'
import { isHoneypotUserId } from '../shared/honeypot'
import { classifyUserId } from '../shared/identity'

/** Everything the ledger needs to know about one settled split. */
export interface SettledMatch {
  matchId: string
  dealId: string
  /** The geohash shard (Durable Object) that matched the pair. */
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
 * Everything the disputes queue needs to know about one dead handshake.
 *
 * `userIds` is required here for the same reason it is on a settled split, and
 * for one more: a resolution says "refund the receiver", and that instruction
 * means nothing unless the row records which account the receiver was.
 */
export interface DisputedMatch {
  matchId: string
  dealId: string
  cell: string
  createdAt: number
  disputedAt: number
  reason: DisputeReason
  /** The side that did confirm, and when — null only for a record that has none. */
  confirmedBy: BuyerRole | null
  confirmedAt: number | null
  /**
   * Integer cents collected from both buyers and not handed back, as of the
   * moment of the dispute. Taken off the payment ledger, never recomputed from
   * the settlement: what a human is being asked about is what Stripe is
   * actually holding, which for a half-refunded match is not the same number.
   */
  heldCents: number
  names: Record<BuyerRole, string>
  userIds: Record<BuyerRole, string>
}

/**
 * Everything the holds queue needs to know about money a teardown could not
 * return.
 *
 * `heldCents` is the figure that decides whether this row exists at all — a
 * teardown whose refund Stripe honoured owes nobody anything and is never
 * written. `userIds` is required for the same reasons it is on a dispute: the
 * write is refused unless the caller states who was out of pocket, and somebody
 * has to be chaseable when the retry keeps failing.
 */
export interface HeldMatch {
  matchId: string
  dealId: string
  cell: string
  createdAt: number
  /** When the match record was deleted and its charges became a tombstone. */
  retiredAt: number
  reason: HoldReason
  /**
   * Integer cents collected and not handed back, off the payment ledger rather
   * than recomputed from the settlement. A half-refunded match holds less than
   * it collected, and this is the money that is actually there.
   */
  heldCents: number
  names: Record<BuyerRole, string>
  userIds: Record<BuyerRole, string>
}

/**
 * The roles a match has, in a fixed order.
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
function assertAuthenticIdentities(match: IdentifiedMatch): void {
  for (const role of SETTLED_ROLES) {
    if (classifyUserId(match.userIds[role]) === 'unauthentic') {
      throw new UnauthenticIdentityError(role)
    }
  }
}

/**
 * Is this a demo pairing rather than a real split?
 *
 * Unauthenticated sockets carry throwaway `demo:` identities, and
 * `ALLOW_DEMO_PAIRING` lets those take a seat so two phones can pair on a stage
 * without Google sign-in (`seatVerdict`). Those pairs
 * run the whole handshake, receipt included, but they are not revenue, and the
 * deck's figures are derived from this ledger — so a stage demo must not be able
 * to book money rows into it. `match_buyers` stores an attacker-chosen
 * `display_name` and no user id, so a booked demo row would be neither
 * distinguishable nor filterable after the fact: the only safe answer is not to
 * write it.
 */
export function isDemoMatch(match: IdentifiedMatch): boolean {
  return Object.values(match.userIds).some((userId) => isDemoUserId(userId))
}

/**
 * Is one side of this a decoy rather than a person?
 *
 * Belt and braces, deliberately, and stated rather than inherited from the demo
 * gate. A honeypot match can never settle and can never be disputed — no pickup
 * code is ever released for one, so no confirmation is ever recorded, so neither
 * terminal path is reachable — and it never holds money, because
 * `paymentDisposition` answers `honeypot` before Stripe is consulted. So nothing
 * should arrive here at all. If some future path made it possible, an operator's
 * queue and a revenue report are the last two places to discover that the server
 * was talking to itself.
 */
export function isHoneypotMatch(match: IdentifiedMatch): boolean {
  return Object.values(match.userIds).some((userId) => isHoneypotUserId(userId))
}

/** Every reason a match's rows are not written: not real, or not a person. */
function isUnbookable(match: IdentifiedMatch): boolean {
  return isDemoMatch(match) || isHoneypotMatch(match)
}

/**
 * The part of a match either gate reads: who it says settled or disputed.
 *
 * Both gates take this rather than a `SettledMatch`, so the disputes queue
 * inherits them instead of growing a second, drifting copy — a demo handshake
 * that ends in a dispute is no more a real dispute than a demo handshake that
 * completes is real revenue.
 */
interface IdentifiedMatch {
  userIds: Record<BuyerRole, string>
}

export interface LedgerStatement {
  sql: string
  /** `null` is a value here, not a missing one: a dispute may have no note. */
  params: (string | number | null)[]
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
  if (isUnbookable(match)) return []

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
  await runBatch(db, ledgerStatements(match), options)
}

/**
 * Run a batch with bounded linear backoff, or nothing at all.
 *
 * Shared by both durable writes so the settled ledger and the disputes queue
 * cannot end up with different retry behaviour — a dispute row is exactly as
 * worth a retry as a settled one, and exactly as un-worth an infinite loop.
 *
 * An empty batch returns before the loop rather than inside it: a demo pairing
 * yields no statements, and an empty batch D1 rejected would otherwise be
 * retried with backoff and then thrown, turning "nothing to write" into an
 * error on a path that is working correctly.
 */
async function runBatch(
  db: D1Database,
  statements: LedgerStatement[],
  options: WriteOptions,
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = options.sleep ?? wait
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

const INSERT_DISPUTE = `INSERT OR IGNORE INTO disputes (
  match_id, deal_id, cell, created_at, disputed_at, reason,
  confirmed_role, confirmed_at,
  orderer_user_id, orderer_name, receiver_user_id, receiver_name,
  held_cents
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/**
 * The row one dead handshake becomes.
 *
 * Both of `ledgerStatements`' gates run here too, in the same order and for the
 * same reasons: an identity that names nobody is a caller bug and is refused,
 * and a demo pairing writes nothing. A stage demo holds no money — a `demo`
 * disposition never reaches Stripe at all — so a demo dispute asks a human to
 * decide about nothing, and the operator's queue is the wrong place to discover
 * that somebody ran a demo.
 */
export function disputeStatements(match: DisputedMatch): LedgerStatement[] {
  assertAuthenticIdentities(match)
  if (isUnbookable(match)) return []

  return [
    {
      // OR IGNORE for the same reason the settled write uses it: the Durable
      // Object retries this write until it succeeds, and a retry after a partial
      // failure must not overwrite a row an operator may already have resolved.
      sql: INSERT_DISPUTE,
      params: [
        match.matchId,
        match.dealId,
        match.cell,
        match.createdAt,
        match.disputedAt,
        match.reason,
        match.confirmedBy,
        match.confirmedAt,
        match.userIds.orderer,
        match.names.orderer,
        match.userIds.receiver,
        match.names.receiver,
        match.heldCents,
      ],
    },
  ]
}

/**
 * File a disputed match for a human to resolve.
 *
 * Retried on a transient D1 failure exactly like a settled split, and for a
 * sharper reason: until this row lands, the only record that two buyers are
 * $8.98 out of pocket lives in one Durable Object's storage, which owns nothing
 * durable by design. The caller (`NuggPool.disputeMatch`) keeps its record until
 * this resolves, so a failure here costs a retry rather than the evidence.
 */
export async function writeDisputedMatch(
  db: D1Database,
  match: DisputedMatch,
  options: WriteOptions = {},
): Promise<void> {
  await runBatch(db, disputeStatements(match), options)
}

/** One dispute as an operator sees it. Money is integer cents, as everywhere. */
export interface DisputeRecord {
  matchId: string
  dealId: string
  cell: string
  createdAt: number
  disputedAt: number
  reason: string
  confirmedBy: BuyerRole | null
  confirmedAt: number | null
  buddies: Record<BuyerRole, { userId: string; name: string }>
  heldCents: number
  resolvedAt: number | null
  resolvedBy: string | null
  resolution: DisputeResolution | null
  /**
   * What Stripe gave back. `null` on a resolved dispute is not zero: it means
   * the refund was never answered for, which is a state a human has to finish.
   *
   * Accumulated across attempts, like `holds.refunded_cents`: a resolution whose
   * refund was declined can be re-asked, and each attempt recovers whichever
   * legs it manages to.
   */
  refundedCents: number | null
  /**
   * What this resolution promised to return and has not, as of the last attempt
   * Stripe answered. `null` for the same reason `refundedCents` is: no attempt
   * has been answered for. Greater than zero is the whole retry condition —
   * see `resolutionDisposition` in `shared/disputes.ts`.
   */
  outstandingCents: number | null
  note: string | null
}

interface DisputeRow {
  match_id: string
  deal_id: string
  cell: string
  created_at: number
  disputed_at: number
  reason: string
  confirmed_role: BuyerRole | null
  confirmed_at: number | null
  orderer_user_id: string
  orderer_name: string
  receiver_user_id: string
  receiver_name: string
  held_cents: number
  resolved_at: number | null
  resolved_by: string | null
  resolution: DisputeResolution | null
  refunded_cents: number | null
  outstanding_cents: number | null
  note: string | null
}

const SELECT_DISPUTE_COLUMNS = `match_id, deal_id, cell, created_at, disputed_at, reason,
  confirmed_role, confirmed_at,
  orderer_user_id, orderer_name, receiver_user_id, receiver_name,
  held_cents, resolved_at, resolved_by, resolution, refunded_cents, outstanding_cents, note`

function toDisputeRecord(row: DisputeRow): DisputeRecord {
  return {
    matchId: row.match_id,
    dealId: row.deal_id,
    cell: row.cell,
    createdAt: row.created_at,
    disputedAt: row.disputed_at,
    reason: row.reason,
    confirmedBy: row.confirmed_role,
    confirmedAt: row.confirmed_at,
    buddies: {
      orderer: { userId: row.orderer_user_id, name: row.orderer_name },
      receiver: { userId: row.receiver_user_id, name: row.receiver_name },
    },
    heldCents: row.held_cents,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
    refundedCents: row.refunded_cents,
    outstandingCents: row.outstanding_cents,
    note: row.note,
  }
}

/** How many disputes one listing hands back, however large a `limit` is asked for. */
export const MAX_DISPUTE_PAGE = 100

/**
 * The operator's queue: open disputes oldest first, so the money that has been
 * held longest is the money at the top of the list.
 *
 * `openOnly` is the default because an operator's question is almost always
 * "what is outstanding"; resolved rows stay readable so a decision can be
 * audited after the fact.
 */
export async function listDisputes(
  db: D1Database,
  options: { openOnly?: boolean; limit?: number } = {},
): Promise<DisputeRecord[]> {
  const openOnly = options.openOnly ?? true
  const limit = Math.min(Math.max(options.limit ?? MAX_DISPUTE_PAGE, 1), MAX_DISPUTE_PAGE)
  const where = openOnly ? 'WHERE resolved_at IS NULL' : ''
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_DISPUTE_COLUMNS} FROM disputes ${where}
       ORDER BY disputed_at ASC LIMIT ?1`,
    )
    .bind(limit)
    .all<DisputeRow>()
  return results.map(toDisputeRecord)
}

export async function getDispute(db: D1Database, matchId: string): Promise<DisputeRecord | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_DISPUTE_COLUMNS} FROM disputes WHERE match_id = ?1`)
    .bind(matchId)
    .first<DisputeRow>()
  return row === null ? null : toDisputeRecord(row)
}

export interface DisputeResolutionRequest {
  matchId: string
  resolution: DisputeResolution
  /** The operator's `users.id`, read off their session and never off the body. */
  resolvedBy: string
  resolvedAt: number
  note: string | null
}

/**
 * Take ownership of an open dispute, and say whether this caller got it.
 *
 * `WHERE resolved_at IS NULL` is the whole concurrency story: two operators
 * resolving the same dispute at the same moment both reach this, exactly one
 * changes a row, and the other is told no. A read-then-write would let both
 * believe they had decided, and only one decision moves the money.
 *
 * Claiming happens *before* the refund is attempted, and `refunded_cents` /
 * `outstanding_cents` are deliberately left NULL here. The same rule the payment
 * ledger follows: a refund is only a refund once Stripe says so, and this row
 * must not claim one that has not been asked for yet.
 *
 * This is the guard on a *first* decision only. Re-asking for the decision this
 * wrote, because its refund never landed, claims nothing — there is nothing left
 * to decide and nothing one operator can take from another, exactly as on the
 * holds queue. `resolutionDisposition` in `shared/disputes.ts` is what decides
 * which POSTs reach this at all.
 */
export async function claimDispute(
  db: D1Database,
  request: DisputeResolutionRequest,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE disputes
         SET resolved_at = ?2, resolved_by = ?3, resolution = ?4, note = ?5
       WHERE match_id = ?1 AND resolved_at IS NULL`,
    )
    .bind(request.matchId, request.resolvedAt, request.resolvedBy, request.resolution, request.note)
    .run()
  return (result.meta.changes ?? 0) === 1
}

export interface DisputeRefundStamp {
  /** What *this* attempt recovered, in integer cents. Added to what came before. */
  refundedCents: number
  /**
   * What the resolution still owes after it — the Durable Object's own answer
   * about the legs Stripe would not confirm, never a figure derived here.
   */
  outstandingCents: number
}

/**
 * Stamp what Stripe actually handed back, once it has answered.
 *
 * Only ever called after the refund round trip. A resolution whose refund call
 * failed leaves both columns NULL rather than 0, because "the money did not
 * move" and "nothing was owed" are different facts and a reconciliation needs to
 * tell them apart.
 *
 * `refunded_cents` accumulates, exactly as `stampHoldRefund` does and for the
 * same reason: a declined refund can be re-asked, each attempt recovers whichever
 * legs it manages to, and the Durable Object reports what *that* attempt got
 * rather than a running total. A plain `SET` here would lose the first attempt's
 * ground on the second — and would overwrite a concurrent retry's recovery with
 * the `0` the loser of that race is correctly told.
 *
 * `outstanding_cents` is replaced outright, because it is an absolute figure: it
 * is what is still owed *now*, and reaching zero is the only thing that closes
 * the retry path.
 */
export async function stampDisputeRefund(
  db: D1Database,
  matchId: string,
  stamp: DisputeRefundStamp,
): Promise<void> {
  await db
    .prepare(
      `UPDATE disputes
          SET refunded_cents = COALESCE(refunded_cents, 0) + ?2,
              outstanding_cents = ?3
        WHERE match_id = ?1`,
    )
    .bind(matchId, stamp.refundedCents, stamp.outstandingCents)
    .run()
}

const INSERT_HOLD = `INSERT OR IGNORE INTO holds (
  match_id, deal_id, cell, created_at, retired_at, reason,
  orderer_user_id, orderer_name, receiver_user_id, receiver_name,
  held_cents
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/**
 * The row one unreturned teardown becomes.
 *
 * Both of `ledgerStatements`' gates run here too, in the same order and for the
 * same reasons. The demo gate is belt and braces rather than theatre: a demo
 * pair never reaches Stripe, so it can never hold money and can never get this
 * far — and if some future path made it possible, an operator's queue is the
 * last place to discover that somebody ran a demo.
 *
 * Nothing about `disputes` is touched from here, deliberately. The two tables
 * answer different questions and a hold must never become a dispute nobody
 * raised.
 */
export function holdStatements(match: HeldMatch): LedgerStatement[] {
  assertAuthenticIdentities(match)
  if (isUnbookable(match)) return []

  return [
    {
      // OR IGNORE for the reason both other writes use it, and one more: the
      // Durable Object replays a failed hold write off its next alarm, and a
      // replay must not overwrite `held_cents` an operator's retry has since
      // brought down.
      sql: INSERT_HOLD,
      params: [
        match.matchId,
        match.dealId,
        match.cell,
        match.createdAt,
        match.retiredAt,
        match.reason,
        match.userIds.orderer,
        match.names.orderer,
        match.userIds.receiver,
        match.names.receiver,
        match.heldCents,
      ],
    },
  ]
}

/**
 * File money a teardown could not give back.
 *
 * Retried on a transient D1 failure exactly like the other two durable writes.
 * Until this row lands, the only record that a buyer is $4.49 out of pocket for
 * a box that does not exist lives in one Durable Object's storage — and unlike
 * a dispute there is no human in the loop to notice, because nobody raised it.
 * The caller (`NuggPool.retireMatch`) parks the row for replay if this throws.
 */
export async function writeHeldMatch(
  db: D1Database,
  match: HeldMatch,
  options: WriteOptions = {},
): Promise<void> {
  await runBatch(db, holdStatements(match), options)
}

/** One hold as an operator sees it. Money is integer cents, as everywhere. */
export interface HoldRecord {
  matchId: string
  dealId: string
  cell: string
  createdAt: number
  retiredAt: number
  reason: string
  buddies: Record<BuyerRole, { userId: string; name: string }>
  heldCents: number
  /**
   * What retries have recovered. `null` is not zero: it means no retry has been
   * answered for yet, which is a different fact from "we asked and got nothing".
   */
  refundedCents: number | null
  retriedAt: number | null
  releasedAt: number | null
}

interface HoldRow {
  match_id: string
  deal_id: string
  cell: string
  created_at: number
  retired_at: number
  reason: string
  orderer_user_id: string
  orderer_name: string
  receiver_user_id: string
  receiver_name: string
  held_cents: number
  refunded_cents: number | null
  retried_at: number | null
  released_at: number | null
}

const SELECT_HOLD_COLUMNS = `match_id, deal_id, cell, created_at, retired_at, reason,
  orderer_user_id, orderer_name, receiver_user_id, receiver_name,
  held_cents, refunded_cents, retried_at, released_at`

function toHoldRecord(row: HoldRow): HoldRecord {
  return {
    matchId: row.match_id,
    dealId: row.deal_id,
    cell: row.cell,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    reason: row.reason,
    buddies: {
      orderer: { userId: row.orderer_user_id, name: row.orderer_name },
      receiver: { userId: row.receiver_user_id, name: row.receiver_name },
    },
    heldCents: row.held_cents,
    refundedCents: row.refunded_cents,
    retriedAt: row.retried_at,
    releasedAt: row.released_at,
  }
}

/** How many holds one listing hands back, however large a `limit` is asked for. */
export const MAX_HOLD_PAGE = 100

/**
 * The money nobody has managed to give back, oldest first — so the cents that
 * have been stuck longest are the cents at the top of the list.
 *
 * `openOnly` is the default for the same reason it is on the disputes queue: an
 * operator's question is almost always "what is outstanding". Released rows stay
 * readable so a retry that finally worked can be audited after the fact.
 */
export async function listHolds(
  db: D1Database,
  options: { openOnly?: boolean; limit?: number } = {},
): Promise<HoldRecord[]> {
  const openOnly = options.openOnly ?? true
  const limit = Math.min(Math.max(options.limit ?? MAX_HOLD_PAGE, 1), MAX_HOLD_PAGE)
  const where = openOnly ? 'WHERE released_at IS NULL' : ''
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_HOLD_COLUMNS} FROM holds ${where}
       ORDER BY retired_at ASC LIMIT ?1`,
    )
    .bind(limit)
    .all<HoldRow>()
  return results.map(toHoldRecord)
}

export async function getHold(db: D1Database, matchId: string): Promise<HoldRecord | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_HOLD_COLUMNS} FROM holds WHERE match_id = ?1`)
    .bind(matchId)
    .first<HoldRow>()
  return row === null ? null : toHoldRecord(row)
}

export interface HoldRefundStamp {
  /** What *this* retry recovered, in integer cents. Added to what came before. */
  refundedCents: number
  /** What is left in the account after it — the pool's own answer, not a guess. */
  heldCents: number
  retriedAt: number
}

/**
 * Stamp what a retry actually recovered, once Stripe has answered.
 *
 * Only ever called after the refund round trip, the same discipline
 * `stampDisputeRefund` follows and for the same reason: a row that claims a
 * refund before the call returns is a row that lies about a refund that failed.
 *
 * `refunded_cents` accumulates because a hold may be retried any number of
 * times and each attempt may recover a different leg; `held_cents` is replaced
 * outright because the pool reports the absolute figure it is still sitting on.
 * A hold that reaches zero is released here and stops appearing in the queue —
 * that is the *only* way `released_at` is ever set, so it can never be stamped
 * on money still in the account.
 */
export async function stampHoldRefund(
  db: D1Database,
  matchId: string,
  stamp: HoldRefundStamp,
): Promise<void> {
  await db
    .prepare(
      `UPDATE holds
          SET refunded_cents = COALESCE(refunded_cents, 0) + ?2,
              held_cents = ?3,
              retried_at = ?4,
              released_at = CASE WHEN ?3 = 0 THEN ?4 ELSE released_at END
        WHERE match_id = ?1`,
    )
    .bind(matchId, stamp.refundedCents, stamp.heldCents, stamp.retriedAt)
    .run()
}

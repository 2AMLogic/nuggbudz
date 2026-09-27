/**
 * When a queue entry or an open match has gone stale.
 *
 * The Durable Object owns the alarm plumbing; this owns the decision. Keeping
 * the decision here means the thing most likely to be argued about — how long a
 * buyer who walked away keeps poisoning the pool — is testable without a
 * Workers runtime.
 */

/** Liveness windows, in milliseconds. */
export interface ExpiryWindows {
  /** Silence from a queued buyer before their entry is dropped. */
  queueIdleMs: number
  /** How far ahead of the drop the buyer is warned. */
  queueWarnLeadMs: number
  /** How long a match may sit unconfirmed before it is cancelled. */
  matchTimeoutMs: number
}

/** Fallbacks for a cell whose Worker vars are unset or malformed. */
export const DEFAULT_EXPIRY_WINDOWS: ExpiryWindows = {
  queueIdleMs: 15 * 60_000,
  queueWarnLeadMs: 2 * 60_000,
  matchTimeoutMs: 10 * 60_000,
}

/** A zero-length window would expire a buyer on arrival, so nothing may be shorter. */
const MIN_WINDOW_MS = 1_000

/** A queued buyer, reduced to what the expiry rule needs to judge them. */
export interface QueueEntry {
  /** Opaque connection id; the caller maps it back to a socket. */
  id: string
  /** Epoch millis of the last sign of life — the join, or the latest ping. */
  lastSeenAt: number
  /** Whether this entry has been warned since its last sign of life. */
  warned: boolean
}

/** A match that has been struck but not yet confirmed or settled. */
export interface OpenMatch {
  matchId: string
  createdAt: number
}

export interface SweepPlan {
  /** Queue entries to warn now. */
  warn: string[]
  /** Queue entries to drop now. */
  expire: string[]
  /** Match ids to cancel now. */
  cancel: string[]
  /**
   * Epoch millis the next decision falls due, or null when nothing is pending.
   * Null is what makes an idle cell free: there is no alarm to re-arm.
   */
  nextDueAt: number | null
}

/**
 * Clamp raw window inputs into something survivable.
 *
 * These arrive as Worker vars, so a typo is a configuration change away from
 * dropping every buyer the instant they join. Unset, unparseable and nonsense
 * values all fall back rather than expiring anyone early.
 */
export function resolveWindows(raw: Partial<ExpiryWindows>): ExpiryWindows {
  const queueIdleMs = clamp(raw.queueIdleMs, DEFAULT_EXPIRY_WINDOWS.queueIdleMs, MIN_WINDOW_MS)
  const lead = clamp(raw.queueWarnLeadMs, DEFAULT_EXPIRY_WINDOWS.queueWarnLeadMs, 0)
  return {
    queueIdleMs,
    // A lead longer than the window would warn a buyer before they joined.
    queueWarnLeadMs: Math.min(lead, queueIdleMs),
    matchTimeoutMs: clamp(raw.matchTimeoutMs, DEFAULT_EXPIRY_WINDOWS.matchTimeoutMs, MIN_WINDOW_MS),
  }
}

function clamp(value: number | undefined, fallback: number, floor: number): number {
  const candidate = value === undefined || !Number.isFinite(value) ? fallback : value
  return Math.max(floor, Math.round(candidate))
}

/** Epoch millis this queue entry is dropped unless something refreshes it. */
export function queueDeadline(entry: QueueEntry, windows: ExpiryWindows): number {
  return entry.lastSeenAt + windows.queueIdleMs
}

/** Epoch millis this queue entry is warned that it is about to be dropped. */
export function queueWarnAt(entry: QueueEntry, windows: ExpiryWindows): number {
  return queueDeadline(entry, windows) - windows.queueWarnLeadMs
}

/** Epoch millis this match is cancelled if nobody has confirmed it. */
export function matchDeadline(match: OpenMatch, windows: ExpiryWindows): number {
  return match.createdAt + windows.matchTimeoutMs
}

/**
 * Decide everything one sweep of a cell should do, and when to wake up next.
 *
 * `nextDueAt` deliberately ignores the work the plan already covers: the caller
 * applies the plan first, so the entries being dropped here no longer exist by
 * the time the next alarm is armed.
 */
export function planSweep(
  now: number,
  queue: readonly QueueEntry[],
  matches: readonly OpenMatch[],
  windows: ExpiryWindows,
): SweepPlan {
  const plan: SweepPlan = { warn: [], expire: [], cancel: [], nextDueAt: null }
  const dueAt = (at: number) => {
    if (plan.nextDueAt === null || at < plan.nextDueAt) plan.nextDueAt = at
  }

  for (const entry of queue) {
    const deadline = queueDeadline(entry, windows)
    if (now >= deadline) {
      plan.expire.push(entry.id)
      continue
    }

    const warnAt = queueWarnAt(entry, windows)
    if (!entry.warned && now >= warnAt) {
      plan.warn.push(entry.id)
      // Warned as of this sweep, so the drop is the next thing owed to them.
      dueAt(deadline)
      continue
    }

    dueAt(entry.warned ? deadline : warnAt)
  }

  for (const match of matches) {
    const deadline = matchDeadline(match, windows)
    if (now >= deadline) plan.cancel.push(match.matchId)
    else dueAt(deadline)
  }

  return plan
}

/**
 * When a cell's alarm should next fire, or null to leave the cell alarmless.
 *
 * Anything already due is scheduled for `now` rather than skipped, so work a
 * missed alarm left behind is not stranded until the next buyer happens to join.
 */
export function nextAlarmAt(now: number, plan: SweepPlan): number | null {
  const pendingNow = plan.warn.length + plan.expire.length + plan.cancel.length
  return pendingNow > 0 ? now : plan.nextDueAt
}

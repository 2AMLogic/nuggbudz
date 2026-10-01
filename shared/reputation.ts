/**
 * Whether a buddy turns up, reduced to a band.
 *
 * A protocol that asks two strangers to meet has exactly one interesting failure
 * mode — one of them does not come — and the pickup handshake already produces
 * the signal: both sides confirming is a completed split, one side confirming
 * alone is a no-show by the other. This module is the whole of what that signal
 * is allowed to become.
 *
 * Deliberately runtime-free: the band feeds the pairing rule in
 * `shared/matchmaker.ts`, the wire type in `shared/protocol.ts` and the receipt
 * the client prints, so it has to be testable without a Workers runtime.
 *
 * **Counts never leave this module.** A band is the only thing the wire, the
 * matcher and the screen ever see. "Missed 3 of 4" is a number a stranger can
 * hold over someone, and it is also a number that is wrong more often than it
 * looks — a dead phone battery and a flake produce the same no-show. So the
 * counters stay in D1, `standingBand` is the only way out of them, and
 * `describeStanding` is the only copy that renders one.
 */

/** The counters D1 keeps per account. Integers, and never shown to anyone. */
export interface ReputationCounts {
  /** Handoffs both sides confirmed. */
  splitsCompleted: number
  /** The other side confirmed and this buyer never did. */
  noShows: number
  /** Walked away after being matched, before anyone confirmed. */
  lateCancels: number
}

export function noReputation(): ReputationCounts {
  return { splitsCompleted: 0, noShows: 0, lateCancels: 0 }
}

/**
 * What a buyer's history is allowed to say about them.
 *
 * Three bands, not five, and no numbers in any of them. `new` is the answer for
 * almost everyone — it is where every buyer starts and where a buyer with one bad
 * night stays.
 */
export type StandingBand = 'new' | 'reliable' | 'spotty'

const BANDS: readonly StandingBand[] = ['new', 'reliable', 'spotty']

/**
 * Pairings a buyer needs before their history says anything at all.
 *
 * Three rather than one because a single missed handoff is as likely to be a flat
 * battery, a queue at the counter, or a buddy who confirmed from the wrong screen
 * as it is to be someone who did not turn up. Banding on one event would mostly
 * band the unlucky.
 */
export const MIN_RATED_PAIRINGS = 3

/**
 * The miss rate that drops a rated buyer out of `reliable`: one in five.
 *
 * A denominator rather than a fraction so the comparison is integer
 * multiplication — `misses * 5 >= pairings` — and no rounding decides anybody's
 * standing.
 */
export const SPOTTY_MISS_DENOMINATOR = 5

/**
 * How close behind the longest-waiting buyer a rival has to be for standing to
 * decide between them.
 *
 * This window is the entire reason preferring good standing cannot starve
 * anybody: it is measured from the longest waiter's *own* join time, so the set
 * of buyers who may be served ahead of them is fixed the moment they sit down and
 * can never grow. See `findMatch` in `shared/matchmaker.ts`.
 */
export const STANDING_TIEBREAK_WINDOW_MS = 45 * 1000

/** Clamp a counter read out of a row to a sane non-negative integer. */
function counter(raw: number): number {
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.trunc(raw))
}

/**
 * The band these counters earn.
 *
 * Total over every combination of counters, including the nonsense ones a
 * hand-edited row could hold — a standing that threw would take the pairing rule
 * down with it.
 */
export function standingBand(counts: ReputationCounts): StandingBand {
  const completed = counter(counts.splitsCompleted)
  const misses = counter(counts.noShows) + counter(counts.lateCancels)
  const pairings = completed + misses
  if (pairings < MIN_RATED_PAIRINGS) return 'new'
  return misses * SPOTTY_MISS_DENOMINATOR >= pairings ? 'spotty' : 'reliable'
}

/**
 * Narrow a band that arrived over the wire.
 *
 * A `matched` message is not hostile the way a client message is, but the client
 * still resolves the band through here rather than rendering the string it was
 * sent: an unknown band reads as `new`, which is the honest answer for "this
 * server told us nothing we understand".
 */
export function parseStandingBand(raw: unknown): StandingBand {
  return BANDS.includes(raw as StandingBand) ? (raw as StandingBand) : 'new'
}

/**
 * How strongly a band is preferred when two buyers are both at the front of the
 * queue. Higher wins; equal ranks fall through to first-come-first-served.
 *
 * An absent band ranks exactly with `new`, which is what makes standing a pure
 * addition to the pairing rule: a shard where nothing is known about anybody
 * matches precisely as it did before this existed.
 */
export function standingRank(band: StandingBand | undefined): number {
  switch (band) {
    case 'reliable':
      return 2
    case 'spotty':
      return 0
    default:
      return 1
  }
}

/** The one place a band becomes words. No counts, by construction. */
export function describeStanding(raw: unknown): { label: string; detail: string } {
  switch (parseStandingBand(raw)) {
    case 'reliable':
      return {
        label: 'Turns up',
        detail: 'Their handoffs have gone through.',
      }
    case 'spotty':
      return {
        label: 'Hit and miss',
        detail: 'Handoffs with them have not always finished. Confirm at the counter.',
      }
    default:
      return {
        label: 'New bud',
        detail: 'Not enough splits yet to say. Everybody starts here.',
      }
  }
}

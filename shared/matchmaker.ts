import { distanceMeters } from './geo'
import { STANDING_TIEBREAK_WINDOW_MS, type StandingBand, standingRank } from './reputation'

/**
 * A buyer waiting in a pool, reduced to just what pairing needs.
 *
 * Kept free of any Durable Object or WebSocket types on purpose: the pairing
 * rule is the part of this system most likely to get an argument, so it has to
 * be testable without a Workers runtime.
 */
export interface Candidate {
  /** Stable id for the connection holding this buyer. */
  id: string
  dealId: string
  lat: number
  lng: number
  /** Epoch millis the buyer joined the queue. Drives fairness. */
  joinedAt: number
  /**
   * How this buyer's past handoffs have gone, if the caller knows — a band, never
   * counts. Read fresh from D1 at match time rather than carried in the queue
   * entry, so a buyer who just completed a split is matched on the standing they
   * actually have. Absent means "not known here", which ranks with `new` and
   * leaves the rule below at pure first-come-first-served.
   */
  standing?: StandingBand
  /**
   * True when this entry is a decoy rather than a person (`shared/honeypot.ts`).
   *
   * A honeypot is a **fallback, not a candidate**: see `findMatch` below. It is
   * carried on the candidate rather than derived from the id here so the rule
   * stays a rule about the queue rather than about an identity format, and so a
   * test can drive it without minting ids.
   */
  honeypot?: boolean
}

export interface MatchDecision {
  /** Places the order and collects the box. Always the longest-waiting buyer. */
  orderer: Candidate
  /** Meets the orderer to collect their half. */
  receiver: Candidate
  distanceMeters: number
}

/** An eligible buyer and how far the joiner has to walk to reach them. */
interface Eligible {
  candidate: Candidate
  meters: number
}

/**
 * Pick a buddy for `joiner` out of `waiting`, or return null to keep waiting.
 *
 * The rule is first-come-first-served on the *waiting* side, softened by one
 * tiebreak. Among everyone eligible, the buyer who has been queued longest is
 * served — except that anyone who joined within `tiebreakWindowMs` *of that
 * longest waiter* counts as being at the front with them, and among the front the
 * better standing goes first. Equal standing falls straight back to who waited
 * longer, so a shard where nothing is known about anybody behaves exactly as it
 * did before standing existed.
 *
 * **The queue stays starvation-free**, and the window is the reason. It is
 * measured from the longest waiter's own `joinedAt`, not from now, so the set of
 * buyers who may be served ahead of them is fixed the instant they sit down and
 * cannot grow however many buyers arrive afterwards. Each pairing removes one of
 * that fixed set, so a buyer in poor standing is served after a bounded number of
 * pairings rather than being pushed back by every new arrival — which is what a
 * sliding "prefer good standing" preference would do. `test/matchmaker.test.ts`
 * drives that case as a simulation.
 *
 * The orderer role is decided by wait time alone, never by standing: whoever
 * waited longest places the order, because they are the one who has been there.
 *
 * **A honeypot is a fallback, never a competitor.** Decoys are removed from
 * contention entirely whenever any real buyer is eligible, before the fairness
 * rule above is applied at all — so every pairing that could have been real
 * still is, and the starvation-free window is computed over real buyers only. A
 * decoy that competed on equal terms would degrade exactly that property, and
 * invisibly: every honeypot match is a real match that did not happen. When one
 * *is* chosen it is always the receiver, whatever it claims to have waited,
 * because the orderer is the buddy who walks to a counter and stands there.
 */
export function findMatch(
  joiner: Candidate,
  waiting: readonly Candidate[],
  radiusMeters: number,
  tiebreakWindowMs: number = STANDING_TIEBREAK_WINDOW_MS,
): MatchDecision | null {
  const all: Eligible[] = []
  for (const candidate of waiting) {
    if (candidate.id === joiner.id) continue
    if (candidate.dealId !== joiner.dealId) continue

    const meters = distanceMeters(candidate, joiner)
    if (meters > radiusMeters) continue

    all.push({ candidate, meters })
  }

  // The fallback rule, applied before anything else looks at the queue: a decoy
  // is considered only when there is nobody real to pair with. A joiner who is
  // themselves a decoy has nothing to fall back to and pairs with real buyers
  // only — two decoys matching each other would be a pairing neither of them
  // could ever complete, occupying a market that has a real buyer in it.
  const real = all.filter((entry) => entry.candidate.honeypot !== true)
  const eligible = real.length > 0 || joiner.honeypot === true ? real : all

  if (eligible.length === 0) return null

  let front = eligible[0]
  for (const entry of eligible) {
    if (entry.candidate.joinedAt < front.candidate.joinedAt) front = entry
  }

  // A negative or malformed window collapses to pure first-come-first-served
  // rather than throwing: this figure is a Worker var, and a typo in it must not
  // take a shard's matching down.
  const window = Number.isFinite(tiebreakWindowMs) ? Math.max(0, tiebreakWindowMs) : 0
  const cutoff = front.candidate.joinedAt + window

  let best = front
  for (const entry of eligible) {
    if (entry.candidate.joinedAt > cutoff) continue
    if (servedFirst(entry.candidate, best.candidate)) best = entry
  }

  // The longest-waiting of the pair places the order — unless one of them is a
  // decoy, which is never the orderer however long it claims to have waited. The
  // orderer is the buddy who walks to a counter, orders a box and waits there
  // holding a code, and a buyer told to go and meet somebody who does not exist
  // is precisely the thing this feature must not do.
  const [orderer, receiver] = decideRoles(best.candidate, joiner)
  return { orderer, receiver, distanceMeters: best.meters }
}

/**
 * Who orders and who collects, for a pair that has already been chosen.
 *
 * Wait time decides it between two real buyers. A decoy is always the receiver,
 * and when both somehow are (which `findMatch` does not produce) the rule falls
 * back to wait time rather than to nothing.
 */
function decideRoles(chosen: Candidate, joiner: Candidate): [Candidate, Candidate] {
  if (chosen.honeypot === true && joiner.honeypot !== true) return [joiner, chosen]
  if (joiner.honeypot === true && chosen.honeypot !== true) return [chosen, joiner]
  return chosen.joinedAt <= joiner.joinedAt ? [chosen, joiner] : [joiner, chosen]
}

/**
 * Between two buyers already at the front of the queue, which one is served.
 *
 * Standing first, then wait time. Strict on both counts, so two buyers who tie on
 * both leave the incumbent in place and the decision stays deterministic.
 */
function servedFirst(a: Candidate, b: Candidate): boolean {
  const byStanding = standingRank(a.standing) - standingRank(b.standing)
  if (byStanding !== 0) return byStanding > 0
  return a.joinedAt < b.joinedAt
}

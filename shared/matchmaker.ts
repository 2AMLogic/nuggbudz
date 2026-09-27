import { distanceMeters } from './geo'

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
}

export interface MatchDecision {
  /** Places the order and collects the box. Always the longest-waiting buyer. */
  orderer: Candidate
  /** Meets the orderer to collect their half. */
  receiver: Candidate
  distanceMeters: number
}

/**
 * Pick a buddy for `joiner` out of `waiting`, or return null to keep waiting.
 *
 * The rule is first-come-first-served on the *waiting* side: among everyone
 * eligible, the buyer who has been queued longest gets paired. That makes the
 * queue starvation-free — you cannot be skipped forever by newer arrivals —
 * and it makes the orderer role fall out naturally, since whoever waited
 * longest is the one who gets to place the order.
 */
export function findMatch(
  joiner: Candidate,
  waiting: readonly Candidate[],
  radiusMeters: number,
): MatchDecision | null {
  let best: Candidate | null = null
  let bestDistance = 0

  for (const candidate of waiting) {
    if (candidate.id === joiner.id) continue
    if (candidate.dealId !== joiner.dealId) continue

    const meters = distanceMeters(candidate, joiner)
    if (meters > radiusMeters) continue

    if (best === null || candidate.joinedAt < best.joinedAt) {
      best = candidate
      bestDistance = meters
    }
  }

  if (best === null) return null

  // The longest-waiting of the pair places the order.
  const [orderer, receiver] = best.joinedAt <= joiner.joinedAt ? [best, joiner] : [joiner, best]
  return { orderer, receiver, distanceMeters: bestDistance }
}

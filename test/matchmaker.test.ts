import { describe, expect, it } from 'vitest'
import { type Candidate, findMatch } from '../shared/matchmaker'
import { STANDING_TIEBREAK_WINDOW_MS } from '../shared/reputation'

const DEAL = 'mcd-nuggets-20'
const RADIUS = 800
const WINDOW = STANDING_TIEBREAK_WINDOW_MS

function buyer(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    dealId: DEAL,
    lat: 37.7749,
    lng: -122.4194,
    joinedAt: 1_000,
    ...overrides,
  }
}

describe('findMatch', () => {
  it('returns null when nobody is waiting', () => {
    expect(findMatch(buyer('a'), [], RADIUS)).toBeNull()
  })

  it('pairs two nearby buyers on the same deal', () => {
    const waiting = [buyer('a', { joinedAt: 1_000 })]
    const decision = findMatch(buyer('b', { joinedAt: 2_000 }), waiting, RADIUS)
    expect(decision).not.toBeNull()
    expect(decision?.orderer.id).toBe('a')
    expect(decision?.receiver.id).toBe('b')
  })

  it('makes the longest-waiting buyer the orderer', () => {
    // The joiner has been waiting longer than the queued buyer, so the joiner orders.
    const waiting = [buyer('a', { joinedAt: 5_000 })]
    const decision = findMatch(buyer('b', { joinedAt: 1_000 }), waiting, RADIUS)
    expect(decision?.orderer.id).toBe('b')
    expect(decision?.receiver.id).toBe('a')
  })

  it('serves the queue first-come-first-served', () => {
    const waiting = [
      buyer('newer', { joinedAt: 9_000 }),
      buyer('oldest', { joinedAt: 1_000 }),
      buyer('middle', { joinedAt: 5_000 }),
    ]
    const decision = findMatch(buyer('joiner', { joinedAt: 10_000 }), waiting, RADIUS)
    expect(decision?.orderer.id).toBe('oldest')
  })

  it('never matches a buyer with themselves', () => {
    const self = buyer('a')
    expect(findMatch(self, [self], RADIUS)).toBeNull()
  })

  it('does not cross deals', () => {
    const waiting = [buyer('a', { dealId: 'wendys-nuggets-20' })]
    expect(findMatch(buyer('b'), waiting, RADIUS)).toBeNull()
  })

  it('refuses a buddy beyond the radius', () => {
    // ~2.2 km north — same city, but not a walk you make for four nuggets.
    const waiting = [buyer('far', { lat: 37.7949 })]
    expect(findMatch(buyer('b'), waiting, RADIUS)).toBeNull()
  })

  it('accepts a buddy just inside the radius and reports the distance', () => {
    const waiting = [buyer('near', { lat: 37.7769 })]
    const decision = findMatch(buyer('b'), waiting, RADIUS)
    expect(decision).not.toBeNull()
    expect(decision?.distanceMeters).toBeGreaterThan(200)
    expect(decision?.distanceMeters).toBeLessThan(240)
  })

  it('prefers the longest-waiting eligible buyer over a closer newer one', () => {
    const waiting = [
      buyer('close-but-new', { lat: 37.77491, joinedAt: 9_000 }),
      buyer('further-but-old', { lat: 37.7769, joinedAt: 1_000 }),
    ]
    const decision = findMatch(buyer('joiner', { joinedAt: 10_000 }), waiting, RADIUS)
    expect(decision?.orderer.id).toBe('further-but-old')
  })
})

describe('findMatch and standing', () => {
  it('changes nothing when no standing is known about anybody', () => {
    // The whole rule has to be a pure addition: a cell with an empty reputation
    // table must pair exactly as it did before standing existed.
    const waiting = [
      buyer('newer', { joinedAt: 9_000 }),
      buyer('oldest', { joinedAt: 1_000 }),
      buyer('middle', { joinedAt: 5_000 }),
    ]
    const joiner = buyer('joiner', { joinedAt: 10_000 })
    expect(findMatch(joiner, waiting, RADIUS)?.orderer.id).toBe('oldest')
  })

  it('prefers good standing among buyers at the front of the queue', () => {
    const waiting = [
      buyer('flaky-first', { joinedAt: 1_000, standing: 'spotty' }),
      buyer('reliable-second', { joinedAt: 1_000 + WINDOW / 2, standing: 'reliable' }),
    ]
    const joiner = buyer('joiner', { joinedAt: 100_000 })
    expect(findMatch(joiner, waiting, RADIUS)?.orderer.id).toBe('reliable-second')
  })

  it('prefers an unrated buyer over one in poor standing', () => {
    const waiting = [
      buyer('flaky-first', { joinedAt: 1_000, standing: 'spotty' }),
      buyer('unrated-second', { joinedAt: 1_000 + WINDOW / 2, standing: 'new' }),
    ]
    const joiner = buyer('joiner', { joinedAt: 100_000 })
    expect(findMatch(joiner, waiting, RADIUS)?.orderer.id).toBe('unrated-second')
  })

  it('will not reach past the window for a better standing', () => {
    // One millisecond outside the front, so first-come-first-served decides and
    // the spotty buyer is served despite the better buyer behind them.
    const waiting = [
      buyer('flaky-first', { joinedAt: 1_000, standing: 'spotty' }),
      buyer('reliable-later', { joinedAt: 1_001 + WINDOW, standing: 'reliable' }),
    ]
    const joiner = buyer('joiner', { joinedAt: 500_000 })
    expect(findMatch(joiner, waiting, RADIUS)?.orderer.id).toBe('flaky-first')
  })

  it('falls back to wait time between buyers of equal standing', () => {
    const waiting = [
      buyer('later', { joinedAt: 5_000, standing: 'reliable' }),
      buyer('earlier', { joinedAt: 2_000, standing: 'reliable' }),
    ]
    const joiner = buyer('joiner', { joinedAt: 10_000 })
    expect(findMatch(joiner, waiting, RADIUS)?.orderer.id).toBe('earlier')
  })

  it('never lets standing decide who places the order', () => {
    // The joiner has waited longest, so the joiner orders — even though the buddy
    // they were preferred into is the one in better standing.
    const waiting = [
      buyer('flaky', { joinedAt: 5_000, standing: 'spotty' }),
      buyer('reliable', { joinedAt: 5_000 + WINDOW / 2, standing: 'reliable' }),
    ]
    const decision = findMatch(buyer('joiner', { joinedAt: 1_000 }), waiting, RADIUS)
    expect(decision?.orderer.id).toBe('joiner')
    expect(decision?.receiver.id).toBe('reliable')
  })

  it('treats a nonsense window as no preference at all', () => {
    const waiting = [
      buyer('flaky-first', { joinedAt: 1_000, standing: 'spotty' }),
      buyer('reliable-second', { joinedAt: 2_000, standing: 'reliable' }),
    ]
    const joiner = buyer('joiner', { joinedAt: 10_000 })
    // A typo in STANDING_TIEBREAK_SECONDS must degrade to first-come-first-served
    // rather than taking a cell's matching down.
    expect(findMatch(joiner, waiting, RADIUS, Number.NaN)?.orderer.id).toBe('flaky-first')
    expect(findMatch(joiner, waiting, RADIUS, -1)?.orderer.id).toBe('flaky-first')
  })

  /**
   * The starvation-freedom guarantee, driven rather than asserted.
   *
   * The adversary is as unkind as the rule allows: every waiting buyer is at the
   * same spot, so nobody is ever ineligible; reliable buyers arrive *twice* as
   * fast as they are consumed, so the queue of better-standing rivals grows
   * without bound; and one buyer in poor standing has been waiting since t=0.
   *
   * A naive "prefer good standing" rule loops here forever. This one cannot,
   * because the tiebreak window is anchored to the longest waiter's own join
   * time: the rivals who may be served ahead of them are only those who arrived
   * inside that window, a set that is finished growing by `WINDOW` and shrinks by
   * one every pairing.
   */
  it('still pairs a low-standing buyer against an endless stream of better ones', () => {
    const INTERVAL = 5_000
    const ARRIVALS_PER_ROUND = 2
    const ROUND_CAP = 1_000

    let queue: Candidate[] = [buyer('low-standing', { joinedAt: 0, standing: 'spotty' })]
    let now = 0
    let rounds = 0
    let skipped = 0
    let pairedAt: number | null = null

    while (pairedAt === null && rounds < ROUND_CAP) {
      rounds++
      now += INTERVAL
      for (let n = 0; n < ARRIVALS_PER_ROUND; n++) {
        queue.push(buyer(`reliable-${rounds}-${n}`, { joinedAt: now, standing: 'reliable' }))
      }

      const decision = findMatch(
        buyer(`joiner-${rounds}`, { joinedAt: now }),
        queue,
        RADIUS,
        WINDOW,
      )
      expect(decision).not.toBeNull()
      const taken =
        decision?.orderer.id === `joiner-${rounds}` ? decision.receiver : decision?.orderer
      if (taken?.id === 'low-standing') pairedAt = now
      else skipped++
      queue = queue.filter((candidate) => candidate.id !== taken?.id)
    }

    // Paired, and inside the bound the window implies: the rivals who could ever
    // outrank them all arrived by `WINDOW`, and one leaves per round.
    expect(pairedAt).not.toBeNull()
    const boundedRounds = (WINDOW / INTERVAL) * ARRIVALS_PER_ROUND + 1
    expect(rounds).toBeLessThanOrEqual(boundedRounds)
    // …and the test is not vacuous: they really were passed over on the way.
    expect(skipped).toBeGreaterThan(0)
  })

  it('serves the low-standing buyer first once the window has passed', () => {
    // The same situation one tick later: every rival arrived outside the window,
    // so wait time alone decides and the spotty buyer is the one served.
    const waiting = [
      buyer('low-standing', { joinedAt: 0, standing: 'spotty' }),
      buyer('reliable-a', { joinedAt: WINDOW + 1, standing: 'reliable' }),
      buyer('reliable-b', { joinedAt: WINDOW + 2, standing: 'reliable' }),
    ]
    const decision = findMatch(buyer('joiner', { joinedAt: WINDOW + 3 }), waiting, RADIUS, WINDOW)
    expect(decision?.orderer.id).toBe('low-standing')
  })
})

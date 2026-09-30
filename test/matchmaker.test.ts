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

/**
 * Honeypots in the queue.
 *
 * The property under test is the one the fairness rule cannot state for itself:
 * a decoy must never take a pairing a real buyer could have had. Every honeypot
 * match is a real match that did not happen, and the degradation is invisible —
 * nothing about it is a type error, a lint finding, or a broken handshake.
 */
describe('findMatch and honeypots', () => {
  const decoy = (id: string, overrides: Partial<Candidate> = {}): Candidate =>
    buyer(id, { honeypot: true, ...overrides })

  it('pairs with a decoy when there is genuinely nobody else', () => {
    // The cold-start case, which is the whole reason decoys exist.
    const decision = findMatch(buyer('real', { joinedAt: 9_000 }), [decoy('fake')], RADIUS)
    expect(decision?.receiver.id).toBe('fake')
  })

  it('prefers any real buyer over a decoy, however long the decoy has waited', () => {
    // The decoy is the longest waiter by an hour, so the fairness rule on its
    // own would serve it first. It is not a candidate at all.
    const waiting = [decoy('fake', { joinedAt: 0 }), buyer('real-buddy', { joinedAt: 3_600_000 })]
    const decision = findMatch(buyer('joiner', { joinedAt: 3_600_001 }), waiting, RADIUS)
    expect([decision?.orderer.id, decision?.receiver.id]).toEqual(['real-buddy', 'joiner'])
  })

  it('never makes a decoy the orderer, even when it waited longest', () => {
    // The orderer walks to a counter, orders a box and stands there holding a
    // code. Sending a buyer to meet somebody who does not exist is the honesty
    // line; holding a code you never use is only a disappointment.
    const decision = findMatch(
      buyer('real', { joinedAt: 5_000 }),
      [decoy('fake', { joinedAt: 0 })],
      RADIUS,
    )
    expect(decision?.orderer.id).toBe('real')
    expect(decision?.receiver.id).toBe('fake')
  })

  it('does not let a decoy pair with another decoy', () => {
    // Two decoys matching each other would occupy a market that has a real
    // buyer standing in it, and could never complete.
    expect(findMatch(decoy('a'), [decoy('b')], RADIUS)).toBeNull()
  })

  it('still pairs a decoy joiner with a real buyer', () => {
    // The fallback is about which side is *offered* one, not about refusing to
    // seat one: `worker/pool.ts` never opens a socket for a decoy, but the rule
    // has to be total.
    expect(findMatch(decoy('a'), [buyer('real')], RADIUS)?.receiver.id).toBe('a')
  })

  it('keeps the standing tiebreak over real buyers only', () => {
    // A decoy carries no standing, so an implementation that ranked it with the
    // rest would let an unrated phantom outrank a `spotty` buyer at the front.
    const waiting = [
      buyer('low-standing', { joinedAt: 0, standing: 'spotty' }),
      decoy('fake', { joinedAt: 1 }),
    ]
    const decision = findMatch(buyer('joiner', { joinedAt: 2 }), waiting, RADIUS, WINDOW)
    expect(decision?.orderer.id).toBe('low-standing')
  })

  /**
   * The simulation the issue's own acceptance criterion names.
   *
   * Decoys are present throughout and are restocked every round, so an
   * implementation that merely *sometimes* prefers a real buyer fails here
   * rather than looking fine. The assertion is that not one of the real buyers
   * ever pairs with one while another real buyer is available — and, as the
   * control, that the decoys were genuinely reachable all along.
   */
  it('lets real buyers pair with each other throughout, with decoys present', () => {
    const ROUNDS = 200
    const INTERVAL = 5_000

    let queue: Candidate[] = []
    let now = 0
    let decoysTaken = 0
    let realPairs = 0

    for (let round = 1; round <= ROUNDS; round++) {
      now += INTERVAL
      // Three phantoms standing there the whole time, restocked as they are
      // consumed, all on the same deal and at the same spot as everybody else.
      while (queue.filter((c) => c.honeypot === true).length < 3) {
        queue.push(decoy(`fake-${round}-${queue.length}`, { joinedAt: now - 60_000 }))
      }
      // Two real buyers arrive per round, one of whom joins and one of whom
      // waits — so from round two onward there is always a real counterpart.
      queue.push(buyer(`real-${round}`, { joinedAt: now }))

      const joiner = buyer(`joiner-${round}`, { joinedAt: now + 1 })
      const decision = findMatch(joiner, queue, RADIUS, WINDOW)
      expect(decision).not.toBeNull()

      const taken = decision?.orderer.id === joiner.id ? decision.receiver : decision?.orderer
      if (taken?.honeypot === true) decoysTaken++
      else realPairs++
      // A decoy is never the one sent to the counter.
      expect(decision?.orderer.honeypot).not.toBe(true)
      queue = queue.filter((candidate) => candidate.id !== taken?.id)
    }

    // Not one round in two hundred, with three phantoms standing in the market
    // the whole time and each of them a minute older than every real arrival.
    expect(decoysTaken).toBe(0)
    expect(realPairs).toBe(ROUNDS)

    // The control: without the fallback rule the decoys would have won almost
    // every round, because they are a minute older than every real arrival.
    const naive = findMatch(
      buyer('control-joiner', { joinedAt: now + 2 }),
      queue.map(({ honeypot: _ignored, ...rest }) => rest),
      RADIUS,
      WINDOW,
    )
    expect(naive).not.toBeNull()
    const naiveTaken = naive?.orderer.id === 'control-joiner' ? naive.receiver : naive?.orderer
    expect(naiveTaken?.id.startsWith('fake-')).toBe(true)
  })
})

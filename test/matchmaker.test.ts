import { describe, expect, it } from 'vitest'
import { type Candidate, findMatch } from '../shared/matchmaker'

const DEAL = 'mcd-nuggets-20'
const RADIUS = 800

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

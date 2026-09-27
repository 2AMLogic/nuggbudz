import { describe, expect, it } from 'vitest'
import {
  bothConfirmed,
  confirmedRole,
  disputeDeadline,
  generatePickupCode,
  isPickupCode,
  isPickupDisputed,
  noConfirmations,
  normalizePickupCode,
  PICKUP_CODE_ALPHABET,
  PICKUP_CODE_LENGTH,
  pendingRole,
} from '../shared/pickup'

describe('generatePickupCode', () => {
  it('produces a code in the alphabet, at the declared length', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePickupCode()
      expect(code).toHaveLength(PICKUP_CODE_LENGTH)
      expect(isPickupCode(code)).toBe(true)
    }
  })

  it('excludes the characters people read wrong off a receipt', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(PICKUP_CODE_ALPHABET).not.toContain(confusable)
    }
  })

  it('is random rather than derived from anything', () => {
    const codes = new Set(Array.from({ length: 500 }, generatePickupCode))
    // 31^6 codes: 500 draws colliding more than a handful of times would mean
    // the generator is not actually spreading over the space.
    expect(codes.size).toBeGreaterThan(495)
  })

  it('never reproduces a match id prefix', () => {
    // The old UI derived the code from the match id, which made it guessable by
    // anyone holding the id. A random code shares nothing with one.
    const matchId = '7d1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b'
    const derived = matchId.replace(/-/g, '').slice(0, PICKUP_CODE_LENGTH).toUpperCase()
    const codes = new Set(Array.from({ length: 500 }, generatePickupCode))
    expect(codes.has(derived)).toBe(false)
  })
})

describe('normalizePickupCode', () => {
  it('forgives case, spaces and dashes', () => {
    expect(normalizePickupCode(' a2-b3 c4 ')).toBe('A2B3C4')
  })

  it('leaves a clean code alone', () => {
    expect(normalizePickupCode('A2B3C4')).toBe('A2B3C4')
  })

  it('does not rescue a code of the wrong length', () => {
    expect(isPickupCode(normalizePickupCode('a2b3'))).toBe(false)
    expect(isPickupCode(normalizePickupCode('a2b3c4d5'))).toBe(false)
  })

  it('does not launder a confusable character into a valid one', () => {
    expect(isPickupCode(normalizePickupCode('O2B3C4'))).toBe(false)
  })
})

describe('handshake state', () => {
  const half = { orderer: 1_000, receiver: null }
  const other = { orderer: null, receiver: 1_000 }
  const full = { orderer: 1_000, receiver: 1_200 }

  it('starts with nobody confirmed', () => {
    const fresh = noConfirmations()
    expect(bothConfirmed(fresh)).toBe(false)
    expect(confirmedRole(fresh)).toBeNull()
    expect(pendingRole(fresh)).toBeNull()
  })

  it('names the side that confirmed and the side that owes one', () => {
    expect(confirmedRole(half)).toBe('orderer')
    expect(pendingRole(half)).toBe('receiver')
    expect(confirmedRole(other)).toBe('receiver')
    expect(pendingRole(other)).toBe('orderer')
  })

  it('only completes when both sides are in', () => {
    expect(bothConfirmed(half)).toBe(false)
    expect(bothConfirmed(other)).toBe(false)
    expect(bothConfirmed(full)).toBe(true)
    expect(pendingRole(full)).toBeNull()
  })
})

describe('dispute timeout', () => {
  const timeout = 300_000

  it('has no deadline before anyone confirms', () => {
    expect(disputeDeadline(noConfirmations(), timeout)).toBeNull()
    expect(isPickupDisputed(noConfirmations(), 9_000_000, timeout)).toBe(false)
  })

  it('runs from the one confirmation on the table', () => {
    expect(disputeDeadline({ orderer: 1_000, receiver: null }, timeout)).toBe(301_000)
    expect(disputeDeadline({ orderer: null, receiver: 5_000 }, timeout)).toBe(305_000)
  })

  it('holds until the deadline, then disputes', () => {
    const half = { orderer: 1_000, receiver: null }
    expect(isPickupDisputed(half, 300_999, timeout)).toBe(false)
    expect(isPickupDisputed(half, 301_000, timeout)).toBe(true)
    expect(isPickupDisputed(half, 900_000, timeout)).toBe(true)
  })

  it('never disputes a handshake both sides finished', () => {
    const full = { orderer: 1_000, receiver: 1_200 }
    expect(disputeDeadline(full, timeout)).toBeNull()
    expect(isPickupDisputed(full, 9_000_000, timeout)).toBe(false)
  })
})

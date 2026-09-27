import { describe, expect, it } from 'vitest'
import { DEALS, findDeal } from '../shared/deals'
import {
  analyzeSpread,
  DealConfigError,
  divideCents,
  formatCents,
  settle,
} from '../shared/economics'

const MCD = findDeal('mcd-nuggets-20')
if (MCD === undefined) throw new Error('fixture deal missing')

describe('divideCents', () => {
  it('splits evenly when it can', () => {
    expect(divideCents(898, 2)).toEqual([449, 449])
  })

  it('gives indivisible remainders to the earliest indices', () => {
    expect(divideCents(100, 3)).toEqual([34, 33, 33])
    expect(divideCents(101, 3)).toEqual([34, 34, 33])
  })

  it('always sums back to the total', () => {
    for (let total = 0; total < 200; total += 7) {
      for (let parts = 1; parts <= 6; parts += 1) {
        const shares = divideCents(total, parts)
        expect(shares).toHaveLength(parts)
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
  })

  it('rejects nonsense', () => {
    expect(() => divideCents(1.5, 2)).toThrow(DealConfigError)
    expect(() => divideCents(100, 0)).toThrow(DealConfigError)
  })
})

describe('settle', () => {
  it('reproduces the McDonalds benchmark from the thesis', () => {
    const s = settle(MCD)
    expect(s.totalCollectedCents).toBe(898)
    expect(s.cogsCents).toBe(799)
    expect(s.platformFeeCents).toBe(99)
    expect(s.shares.map((share) => share.payCents)).toEqual([449, 449])
    expect(s.shares.map((share) => share.savingsCents)).toEqual([250, 250])
    expect(s.shares.map((share) => share.savingsPct)).toEqual([36, 36])
    expect(s.shares.map((share) => share.piecesOwed)).toEqual([10, 10])
    expect(s.shares.map((share) => share.role)).toEqual(['orderer', 'receiver'])
  })

  it('keeps the platform whole for every deal and party size', () => {
    for (const deal of DEALS) {
      for (let partySize = 2; partySize <= 4; partySize += 1) {
        const s = settle(deal, partySize)
        const collected = s.shares.reduce((sum, share) => sum + share.payCents, 0)
        expect(collected).toBe(s.cogsCents + s.platformFeeCents)
        expect(s.shares.reduce((sum, share) => sum + share.piecesOwed, 0)).toBe(deal.bulk.pieces)
      }
    }
  })

  it('charges the orderer the stray cent', () => {
    const odd = { ...MCD, platformFeeCents: 100 }
    const s = settle(odd, 3)
    expect(s.shares.map((share) => share.payCents)).toEqual([300, 300, 299])
    expect(s.shares[0].role).toBe('orderer')
  })

  it('refuses a party of one', () => {
    expect(() => settle(MCD, 1)).toThrow(DealConfigError)
  })

  it('refuses to split fewer pieces than buyers', () => {
    expect(() => settle(MCD, 21)).toThrow(DealConfigError)
  })
})

describe('analyzeSpread', () => {
  it('reports the retail spread the protocol arbitrages', () => {
    const spread = analyzeSpread(MCD)
    expect(spread.soloTotalCents).toBe(1398)
    expect(spread.bulkPriceCents).toBe(799)
    expect(spread.grossSpreadCents).toBe(599)
    expect(spread.grossMarginPct).toBe(43)
  })
})

describe('formatCents', () => {
  it('renders money the way a receipt does', () => {
    expect(formatCents(449)).toBe('$4.49')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(1000)).toBe('$10.00')
    expect(formatCents(-250)).toBe('-$2.50')
  })
})

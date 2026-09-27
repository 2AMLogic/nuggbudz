import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { settle } from '../shared/economics'
import { ledgerStatements, type SettledMatch } from '../worker/ledger'

const deal = findDeal('mcd-nuggets-20')
if (deal === undefined) throw new Error('benchmark deal missing from the catalogue')

const settled: SettledMatch = {
  matchId: 'match-1',
  dealId: deal.id,
  cell: '9q8yyk',
  distanceMeters: 42.5,
  createdAt: 1_700_000_000_000,
  settledAt: 1_700_000_060_000,
  settlement: settle(deal, 2),
  names: { orderer: 'Robb', receiver: 'Dana' },
}

describe('ledgerStatements', () => {
  it('writes one match row and one row per buyer', () => {
    const statements = ledgerStatements(settled)
    expect(statements).toHaveLength(3)
    expect(statements[0].sql).toContain('INTO matches')
    expect(statements[1].sql).toContain('INTO match_buyers')
    expect(statements[2].sql).toContain('INTO match_buyers')
  })

  it('books the settlement the buddies were shown, in integer cents', () => {
    const [match, orderer, receiver] = ledgerStatements(settled)
    expect(match.params).toEqual([
      'match-1',
      'mcd-nuggets-20',
      '9q8yyk',
      2,
      settled.settlement.totalCollectedCents,
      settled.settlement.cogsCents,
      settled.settlement.platformFeeCents,
      42.5,
      1_700_000_000_000,
      1_700_000_060_000,
    ])
    expect(orderer.params).toEqual(['match-1', 'orderer', 'Robb', 449, 699, 10])
    expect(receiver.params).toEqual(['match-1', 'receiver', 'Dana', 449, 699, 10])
  })

  it('sums the booked halves back to the collected total', () => {
    const buyerRows = ledgerStatements(settled).slice(1)
    const paid = buyerRows.reduce((total, row) => total + Number(row.params[3]), 0)
    expect(paid).toBe(settled.settlement.totalCollectedCents)
  })

  it('is idempotent, so a retry cannot rewrite a booked split', () => {
    for (const statement of ledgerStatements(settled)) {
      expect(statement.sql.startsWith('INSERT OR IGNORE')).toBe(true)
    }
  })

  it('binds one parameter per placeholder', () => {
    for (const statement of ledgerStatements(settled)) {
      expect(statement.params).toHaveLength((statement.sql.match(/\?/g) ?? []).length)
    }
  })
})

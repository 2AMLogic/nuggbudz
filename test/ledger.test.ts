import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { demoUserId } from '../shared/demo'
import { settle } from '../shared/economics'
import { isDemoMatch, ledgerStatements, type SettledMatch } from '../worker/ledger'

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
  userIds: { orderer: 'user-robb', receiver: 'user-dana' },
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

describe('the demo gate', () => {
  const demo = demoUserId('7f0e1d2c-3b4a-5968-8776-655443322110')

  it('books nothing when both buddies are demo identities', () => {
    const pairing: SettledMatch = {
      ...settled,
      userIds: { orderer: demo, receiver: demoUserId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') },
    }
    expect(isDemoMatch(pairing)).toBe(true)
    expect(ledgerStatements(pairing)).toEqual([])
  })

  it('books nothing when only one side is a demo identity', () => {
    // A real account paired with a stage phone is still not revenue, and
    // `match_buyers` has no user-id column to record which half was fake.
    for (const userIds of [
      { orderer: demo, receiver: 'user-dana' },
      { orderer: 'user-robb', receiver: demo },
    ]) {
      const mixed: SettledMatch = { ...settled, userIds }
      expect(isDemoMatch(mixed)).toBe(true)
      expect(ledgerStatements(mixed)).toEqual([])
    }
  })

  it('still books a split between two real accounts', () => {
    expect(isDemoMatch(settled)).toBe(false)
    expect(ledgerStatements(settled)).toHaveLength(3)
  })

  it('is not fooled by a display name that merely looks like a demo id', () => {
    const spoofed: SettledMatch = { ...settled, names: { orderer: 'demo:Robb', receiver: 'Dana' } }
    expect(isDemoMatch(spoofed)).toBe(false)
    expect(ledgerStatements(spoofed)).toHaveLength(3)
  })
})

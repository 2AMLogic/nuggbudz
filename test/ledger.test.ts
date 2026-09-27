import { describe, expect, it, vi } from 'vitest'
import { settle } from '../shared/economics'
import { recordSettledMatch, type SettledMatch } from '../worker/ledger'

/**
 * A fake D1Database just faithful enough to exercise recordSettledMatch: it
 * records every prepared statement's SQL and bound params, and lets a test
 * script `batch` to fail some number of times before succeeding.
 */
function fakeDb(batchImpl: (calls: { sql: string; params: unknown[] }[][]) => unknown) {
  const calls: { sql: string; params: unknown[] }[][] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return { sql, params }
        },
      }
    },
    batch(statements: { sql: string; params: unknown[] }[]) {
      calls.push(statements)
      return batchImpl(calls)
    },
    // Unused by recordSettledMatch, present only to satisfy the D1Database type.
    exec: vi.fn(),
    withSession: vi.fn(),
    dump: vi.fn(),
  }
  return { db: db as unknown as D1Database, calls }
}

const settlement = settle(
  {
    id: 'test-deal',
    merchant: 'Test',
    label: 'Test deal',
    bulk: { item: '20pc', pieces: 20, priceCents: 899 },
    solo: { item: '10pc', pieces: 10, priceCents: 699 },
    platformFeeCents: 99,
    partySize: 2,
  },
  2,
)

function testMatch(overrides: Partial<SettledMatch> = {}): SettledMatch {
  return {
    matchId: 'match-1',
    dealId: 'test-deal',
    cell: '9q8yyk',
    createdAt: 1000,
    settledAt: 1500,
    distanceMeters: 42,
    settlement,
    buyers: [
      { role: 'orderer', displayName: 'Robb' },
      { role: 'receiver', displayName: 'Dana' },
    ],
    ...overrides,
  }
}

describe('recordSettledMatch', () => {
  it('writes one matches row and one match_buyers row per buyer, in one batch', async () => {
    const { db, calls } = fakeDb(() => [])
    await recordSettledMatch(db, testMatch())

    expect(calls).toHaveLength(1)
    const [statements] = calls
    expect(statements).toHaveLength(3) // 1 match + 2 buyers
    expect(statements[0].sql).toMatch(/INSERT OR IGNORE INTO matches/)
    expect(statements[0].params).toEqual([
      'match-1',
      'test-deal',
      '9q8yyk',
      2,
      settlement.totalCollectedCents,
      settlement.cogsCents,
      settlement.platformFeeCents,
      42,
      1000,
      1500,
    ])
    expect(statements[1].sql).toMatch(/INSERT OR IGNORE INTO match_buyers/)
    expect(statements[1].params[1]).toBe('orderer')
    expect(statements[2].params[1]).toBe('receiver')
  })

  it('uses INSERT OR IGNORE so a retry never duplicates rows', async () => {
    const { db, calls } = fakeDb(() => [])
    await recordSettledMatch(db, testMatch())
    await recordSettledMatch(db, testMatch())

    expect(calls).toHaveLength(2)
    for (const statements of calls) {
      for (const s of statements) expect(s.sql).toMatch(/INSERT OR IGNORE/)
    }
  })

  it('retries on failure and succeeds once D1 recovers', async () => {
    let attempts = 0
    const { db, calls } = fakeDb(() => {
      attempts++
      if (attempts < 3) throw new Error('D1 is down')
      return []
    })

    await recordSettledMatch(db, testMatch(), { retryDelayMs: 1 })

    expect(attempts).toBe(3)
    expect(calls).toHaveLength(3)
  })

  it('logs and swallows the error rather than throwing after exhausting retries', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = fakeDb(() => {
      throw new Error('D1 is permanently down')
    })

    await expect(
      recordSettledMatch(db, testMatch(), { maxAttempts: 2, retryDelayMs: 1 }),
    ).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledOnce()

    errorSpy.mockRestore()
  })
})

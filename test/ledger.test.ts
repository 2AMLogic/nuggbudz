import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { settle } from '../shared/economics'
import { ledgerStatements, type SettledMatch, writeSettledMatch } from '../worker/ledger'

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

/**
 * A fake D1 that fails its first `failures` batches, then succeeds.
 *
 * Only the surface `writeSettledMatch` touches is modelled — `prepare().bind()`
 * and `batch()` — so this stays a unit test with no Workers runtime.
 */
function flakyDb(failures: number) {
  const calls: { attempts: number; batched: number[] } = { attempts: 0, batched: [] }
  const db = {
    prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ sql, params }) }),
    batch: async (statements: unknown[]) => {
      calls.attempts += 1
      if (calls.attempts <= failures) throw new Error('D1_ERROR: network')
      calls.batched.push(statements.length)
      return []
    },
  }
  return { db: db as unknown as D1Database, calls }
}

/** Records the backoff without waiting for it. */
function recordingSleep() {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => void slept.push(ms) }
}

describe('writeSettledMatch', () => {
  it('books the split on the first try when D1 is healthy', async () => {
    const { db, calls } = flakyDb(0)
    await writeSettledMatch(db, settled)
    expect(calls.attempts).toBe(1)
    expect(calls.batched).toEqual([3])
  })

  it('retries a transient batch failure and eventually books the row', async () => {
    const { db, calls } = flakyDb(2)
    const { slept, sleep } = recordingSleep()
    await writeSettledMatch(db, settled, { sleep })
    expect(calls.attempts).toBe(3)
    expect(calls.batched).toEqual([3])
    // Linear backoff: attempt 1 waits 200ms, attempt 2 waits 400ms.
    expect(slept).toEqual([200, 400])
  })

  it('gives up after the bounded attempts and rethrows, rather than silently losing the row', async () => {
    const { db, calls } = flakyDb(Number.POSITIVE_INFINITY)
    const { sleep } = recordingSleep()
    await expect(writeSettledMatch(db, settled, { sleep })).rejects.toThrow('D1_ERROR')
    expect(calls.attempts).toBe(3)
  })

  it('honours an overridden attempt bound', async () => {
    const { db, calls } = flakyDb(4)
    const { sleep } = recordingSleep()
    await writeSettledMatch(db, settled, { maxAttempts: 5, sleep })
    expect(calls.attempts).toBe(5)
  })

  it('does not sleep when it is not going to retry', async () => {
    const { db } = flakyDb(Number.POSITIVE_INFINITY)
    const { slept, sleep } = recordingSleep()
    await expect(writeSettledMatch(db, settled, { maxAttempts: 1, sleep })).rejects.toThrow()
    expect(slept).toEqual([])
  })
})

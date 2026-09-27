import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { settle } from '../shared/economics'
import { type SettledMatchRecord, writeSettledMatch } from '../worker/ledger'

const MCD = findDeal('mcd-nuggets-20')
if (MCD === undefined) throw new Error('fixture deal missing')

/**
 * A minimal in-memory stand-in for D1, faithful enough to prove the two
 * things a real database would enforce that a plain call-recording mock
 * would not: `INSERT OR IGNORE` actually dedupes on the primary key, and a
 * `batch` failure leaves no partial rows behind.
 */
class FakeD1 {
  matches = new Map<string, unknown[]>()
  matchBuyers = new Map<string, unknown[]>()
  batchCalls: unknown[][] = []
  failNextBatches = 0

  prepare(sql: string) {
    const trimmed = sql.trim()
    const bound: unknown[] = []
    const apply = () => {
      if (trimmed.startsWith('INSERT OR IGNORE INTO matches')) {
        const matchId = String(bound[0])
        if (!this.matches.has(matchId)) this.matches.set(matchId, bound)
      } else if (trimmed.startsWith('INSERT OR IGNORE INTO match_buyers')) {
        const key = `${bound[0]}:${bound[1]}`
        if (!this.matchBuyers.has(key)) this.matchBuyers.set(key, bound)
      } else {
        throw new Error(`FakeD1 does not understand: ${trimmed}`)
      }
    }
    const stmt = {
      bind(...args: unknown[]) {
        bound.push(...args)
        return stmt
      },
      __apply: apply,
    }
    return stmt
  }

  async batch(statements: { __apply: () => void }[]) {
    if (this.failNextBatches > 0) {
      this.failNextBatches--
      throw new Error('simulated D1 outage')
    }
    this.batchCalls.push(statements)
    for (const stmt of statements) stmt.__apply()
    return statements.map(() => ({ success: true }))
  }
}

// An arrow function expression, not a hoisted declaration, so the compiler's
// narrowing of `MCD` above (a `const`, never reassigned) still applies inside it.
const record = (overrides: Partial<SettledMatchRecord> = {}): SettledMatchRecord => {
  return {
    matchId: 'match-1',
    dealId: MCD.id,
    cell: '9q8yyk',
    settlement: settle(MCD, 2),
    distanceMeters: 42,
    createdAt: 1_000,
    settledAt: 1_000,
    ordererName: 'Robb',
    receiverName: 'Dana',
    ...overrides,
  }
}

describe('writeSettledMatch', () => {
  it('writes exactly one matches row and one match_buyers row per buyer, in one batch', async () => {
    const db = new FakeD1()
    await writeSettledMatch(db as unknown as D1Database, record())

    expect(db.batchCalls).toHaveLength(1)
    expect(db.batchCalls[0]).toHaveLength(3)
    expect(db.matches.size).toBe(1)
    expect(db.matchBuyers.size).toBe(2)
    expect(db.matchBuyers.has('match-1:orderer')).toBe(true)
    expect(db.matchBuyers.has('match-1:receiver')).toBe(true)
  })

  it('carries the cell and both timestamps through to the matches row', async () => {
    const db = new FakeD1()
    await writeSettledMatch(
      db as unknown as D1Database,
      record({ cell: 'u4pruy', createdAt: 5, settledAt: 9 }),
    )

    const row = db.matches.get('match-1')
    expect(row).toBeDefined()
    // match_id, deal_id, cell, party_size, total_collected_cents, cogs_cents,
    // platform_fee_cents, distance_meters, created_at, settled_at
    expect(row?.[2]).toBe('u4pruy')
    expect(row?.[8]).toBe(5)
    expect(row?.[9]).toBe(9)
  })

  it('is idempotent on match_id — a retried write does not duplicate rows', async () => {
    const db = new FakeD1()
    await writeSettledMatch(db as unknown as D1Database, record())
    await writeSettledMatch(db as unknown as D1Database, record())

    expect(db.batchCalls).toHaveLength(2)
    expect(db.matches.size).toBe(1)
    expect(db.matchBuyers.size).toBe(2)
  })

  it('retries on failure and eventually succeeds', async () => {
    const db = new FakeD1()
    db.failNextBatches = 2
    await writeSettledMatch(db as unknown as D1Database, record())

    expect(db.matches.size).toBe(1)
    expect(db.matchBuyers.size).toBe(2)
  })

  it('swallows a persistent D1 failure rather than throwing — the live match must not break', async () => {
    const db = new FakeD1()
    db.failNextBatches = Number.POSITIVE_INFINITY
    await expect(writeSettledMatch(db as unknown as D1Database, record())).resolves.toBeUndefined()

    expect(db.matches.size).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { demoUserId } from '../shared/demo'
import { settle } from '../shared/economics'
import {
  isDemoMatch,
  ledgerStatements,
  type SettledMatch,
  UnauthenticIdentityError,
  writeSettledMatch,
} from '../worker/ledger'

const deal = findDeal('mcd-nuggets-20')
if (deal === undefined) throw new Error('benchmark deal missing from the catalogue')

/**
 * Real account ids, shaped as `crypto.randomUUID()` mints `users.id` — the
 * ledger now books money only against an id a sign-in could actually have
 * produced, so a readable stand-in like `user-robb` is no longer one.
 */
const ROBB = '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c'
const DANA = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

const settled: SettledMatch = {
  matchId: 'match-1',
  dealId: deal.id,
  cell: '9q8yyk',
  distanceMeters: 42.5,
  createdAt: 1_700_000_000_000,
  settledAt: 1_700_000_060_000,
  settlement: settle(deal, 2),
  names: { orderer: 'Robb', receiver: 'Dana' },
  userIds: { orderer: ROBB, receiver: DANA },
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
      { orderer: demo, receiver: DANA },
      { orderer: ROBB, receiver: demo },
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

/**
 * The gap the demo gate alone left open (issue #55).
 *
 * `userIds` being a required field means a caller has to *state* who settled;
 * these prove the ledger now also checks that the statement could be true.
 * Every case here type-checks — that is the whole point — and before the
 * authenticity gate each one booked a full set of money rows.
 */
describe('the authenticity gate', () => {
  const empty = { orderer: '', receiver: '' }

  it('refuses an empty identity rather than booking it', () => {
    const nobody: SettledMatch = { ...settled, userIds: empty }
    // The old behaviour, for the record: empty ids are not demo ids, so the
    // prefix test waved them through as a real split.
    expect(isDemoMatch(nobody)).toBe(false)
    expect(() => ledgerStatements(nobody)).toThrow(UnauthenticIdentityError)
  })

  it('names the side that could not be identified', () => {
    for (const [role, userIds] of [
      ['orderer', { ...empty, receiver: DANA }],
      ['receiver', { ...empty, orderer: ROBB }],
    ] as const) {
      const half: SettledMatch = { ...settled, userIds }
      expect(() => ledgerStatements(half)).toThrow(new UnauthenticIdentityError(role).message)
    }
  })

  it('refuses an id that is neither an account nor a demo pairing', () => {
    for (const bogus of [
      'user-robb', // a readable stand-in, not an id anything mints
      'DEMO:abc', // close enough to the demo prefix to be missed by a prefix test
      ' ',
      'demo:', // prefixed, but identifying nobody
      `${ROBB} `,
    ]) {
      for (const userIds of [
        { orderer: bogus, receiver: DANA },
        { orderer: ROBB, receiver: bogus },
      ]) {
        expect(() => ledgerStatements({ ...settled, userIds })).toThrow(UnauthenticIdentityError)
      }
    }
  })

  it('catches an id that is missing entirely, which only an untyped caller can do', () => {
    // `tsc` rejects this; a future JS caller, or a record rebuilt from storage,
    // can still produce it — so the check iterates the roles rather than the keys.
    const halfFilled = { ...settled, userIds: { orderer: ROBB } as SettledMatch['userIds'] }
    expect(() => ledgerStatements(halfFilled)).toThrow(UnauthenticIdentityError)
  })

  it('still books a split between two real accounts', () => {
    expect(ledgerStatements(settled)).toHaveLength(3)
  })

  it('still books nothing, and throws nothing, for a demo pairing', () => {
    // The two outcomes must stay distinct: a demo handshake is working as
    // designed and books nothing quietly, an unauthentic id is a caller bug.
    const pairing: SettledMatch = {
      ...settled,
      userIds: { orderer: demoUserId(crypto.randomUUID()), receiver: demoUserId('two') },
    }
    expect(ledgerStatements(pairing)).toEqual([])
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

  it('never touches D1 for a demo pairing, and does not retry its way to an error', async () => {
    // The gate has to return before the retry loop: a demo match produces no
    // statements, and an empty batch that D1 rejected would otherwise be retried
    // with backoff and then rethrown on a path that is working correctly.
    const { db, calls } = flakyDb(Number.POSITIVE_INFINITY)
    const { slept, sleep } = recordingSleep()
    const pairing: SettledMatch = {
      ...settled,
      userIds: { orderer: demoUserId('a'), receiver: demoUserId('b') },
    }
    await expect(writeSettledMatch(db, pairing, { sleep })).resolves.toBeUndefined()
    expect(calls.attempts).toBe(0)
    expect(slept).toEqual([])
  })

  it('refuses an empty identity at the write, without touching D1 or retrying', async () => {
    // The proof that the hole in issue #55 is closed where it mattered: a
    // healthy D1 that would have booked the row is never asked to.
    const { db, calls } = flakyDb(0)
    const { slept, sleep } = recordingSleep()
    const nobody: SettledMatch = { ...settled, userIds: { orderer: '', receiver: '' } }
    await expect(writeSettledMatch(db, nobody, { sleep })).rejects.toThrow(UnauthenticIdentityError)
    expect(calls.attempts).toBe(0)
    expect(calls.batched).toEqual([])
    expect(slept).toEqual([])
  })
})

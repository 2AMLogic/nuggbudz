import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { demoUserId } from '../shared/demo'
import { settle } from '../shared/economics'
import { HOLD_REASONS, parseHoldReason, parseHoldRetryRequest } from '../shared/holds'
import adminSource from '../worker/admin.ts?raw'
import {
  type HeldMatch,
  holdStatements,
  UnauthenticIdentityError,
  writeHeldMatch,
} from '../worker/ledger'
import {
  collectedCents,
  hasOutstandingMoney,
  holdsCollectedMoney,
  openLedger,
  type PaymentLedger,
} from '../worker/lib/payments'
import poolSource from '../worker/pool.ts?raw'

const deal = findDeal('mcd-nuggets-20')
if (deal === undefined) throw new Error('benchmark deal missing from the catalogue')

const settlement = settle(deal, 2)

/** Real account ids, shaped as `crypto.randomUUID()` mints `users.id`. */
const ROBB = '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c'
const DANA = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

const held: HeldMatch = {
  matchId: 'match-3',
  dealId: deal.id,
  cell: '9q8',
  createdAt: 1_700_000_000_000,
  retiredAt: 1_700_000_120_000,
  reason: 'buddy_left',
  heldCents: settlement.shares[0].payCents,
  names: { orderer: 'Robb', receiver: 'Dana' },
  userIds: { orderer: ROBB, receiver: DANA },
}

const ledgerWith = (statuses: PaymentLedger['legs'][number]['status'][]): PaymentLedger => {
  const base = openLedger(settlement, { matchId: 'match-3', cell: '9q8' }, ['pi_1', 'pi_2'])
  return { ...base, legs: base.legs.map((leg, i) => ({ ...leg, status: statuses[i] })) }
}

describe('parseHoldReason', () => {
  it('accepts every non-dispute teardown the pool can produce', () => {
    for (const reason of HOLD_REASONS) expect(parseHoldReason(reason)).toBe(reason)
  })

  it('refuses the two teardowns whose money is already answered for', () => {
    // The gate, not just a parser: `retireMatch` files a hold only for a reason
    // this answers, which is the single condition keeping a settled split out of
    // the queue and a dispute out of two queues at once.
    expect(parseHoldReason('settled')).toBeNull()
    expect(parseHoldReason('disputed')).toBeNull()
  })

  it('refuses anything else, including the absence of one', () => {
    for (const bogus of [undefined, null, '', 'BUDDY_LEFT', 'timeout', 0, {}]) {
      expect(parseHoldReason(bogus)).toBeNull()
    }
  })
})

describe('parseHoldRetryRequest', () => {
  it('accepts a well-formed instruction', () => {
    expect(parseHoldRetryRequest(JSON.stringify({ matchId: 'match-3' }))).toEqual({
      matchId: 'match-3',
    })
  })

  it('rejects malformed json and non-objects', () => {
    for (const bad of ['nope', 'null', '[]', '"match-3"']) {
      expect(parseHoldRetryRequest(bad)).toBeNull()
    }
  })

  it('rejects a missing or unusable match id', () => {
    for (const matchId of [undefined, null, '', 7]) {
      expect(parseHoldRetryRequest(JSON.stringify({ matchId }))).toBeNull()
    }
  })

  it('carries nothing but the match, so a caller cannot widen what is refunded', () => {
    // There is nothing to decide about a hold. A request that could name roles,
    // or an amount, would be a second way to move money that no operator chose.
    const parsed = parseHoldRetryRequest(
      JSON.stringify({ matchId: 'match-3', roles: ['orderer'], amountCents: 999 }),
    )
    expect(parsed).toEqual({ matchId: 'match-3' })
  })
})

/**
 * The predicate the whole feature keys on, against the one it is easy to
 * mistake for.
 */
describe('holdsCollectedMoney', () => {
  it('is true only when a buyer is actually out of pocket', () => {
    expect(holdsCollectedMoney(ledgerWith(['succeeded', 'failed']))).toBe(true)
    expect(holdsCollectedMoney(ledgerWith(['succeeded', 'succeeded']))).toBe(true)
  })

  it('is false for a ledger that only has money still in flight', () => {
    // The distinction that decides whether a row is written: a `pending` leg is
    // a webhook to wait for, not money anybody has lost. Filing a hold for one
    // would put an unstarted payment in an operator's "money we owe" queue.
    const pending = ledgerWith(['pending', 'pending'])
    expect(hasOutstandingMoney(pending)).toBe(true)
    expect(holdsCollectedMoney(pending)).toBe(false)
  })

  it('is false once every collected leg is confirmably refunded', () => {
    // The edge case the listing turns on: a teardown whose refund fully
    // succeeded owes nobody anything and must never appear in the queue.
    const refunded = ledgerWith(['refunded', 'failed'])
    expect(collectedCents(refunded)).toBe(0)
    expect(holdsCollectedMoney(refunded)).toBe(false)
  })

  it('agrees with collectedCents rather than restating it', () => {
    for (const statuses of [
      ['pending', 'pending'],
      ['succeeded', 'pending'],
      ['refunded', 'refunded'],
      ['failed', 'succeeded'],
    ] as const) {
      const ledger = ledgerWith([...statuses])
      expect(holdsCollectedMoney(ledger)).toBe(collectedCents(ledger) > 0)
    }
  })
})

describe('holdStatements', () => {
  it('writes exactly one row, into the holds table and nowhere else', () => {
    const statements = holdStatements(held)
    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toContain('INTO holds')
    // A parallel surface, never a fold-in: a hold is not a dispute nobody
    // raised, and the settled ledger is a revenue report.
    expect(statements[0].sql).not.toContain('INTO disputes')
    expect(statements[0].sql).not.toContain('INTO matches')
    expect(statements[0].sql).not.toContain('INTO match_buyers')
  })

  it('records the match, the teardown, both buddies and what is held', () => {
    const [row] = holdStatements(held)
    expect(row.params).toEqual([
      'match-3',
      'mcd-nuggets-20',
      '9q8',
      1_700_000_000_000,
      1_700_000_120_000,
      'buddy_left',
      ROBB,
      'Robb',
      DANA,
      'Dana',
      settlement.shares[0].payCents,
    ])
  })

  it('has a row shape for every teardown reason in the catalogue', () => {
    // Enumerated rather than sampled: a fifth teardown added to `HOLD_REASONS`
    // without a matching CHECK value would fail the whole batch at runtime.
    for (const reason of HOLD_REASONS) {
      const [row] = holdStatements({ ...held, reason })
      expect(row.params).toContain(reason)
    }
  })

  it('carries the held money as integer cents, never a float', () => {
    for (const heldCents of [1, 449, 898]) {
      const [row] = holdStatements({ ...held, heldCents })
      expect(row.params.at(-1)).toBe(heldCents)
      expect(Number.isInteger(row.params.at(-1))).toBe(true)
    }
  })

  it('is idempotent, so a parked write can be replayed until it lands', () => {
    // And so a replay cannot overwrite a `held_cents` an operator's retry has
    // since brought down.
    expect(holdStatements(held)[0].sql.startsWith('INSERT OR IGNORE')).toBe(true)
  })

  it('binds one parameter per placeholder', () => {
    for (const statement of holdStatements(held)) {
      expect(statement.params).toHaveLength((statement.sql.match(/\?/g) ?? []).length)
    }
  })

  it('files nothing for a demo pairing', () => {
    for (const userIds of [
      { orderer: demoUserId('a'), receiver: demoUserId('b') },
      { orderer: demoUserId('a'), receiver: DANA },
      { orderer: ROBB, receiver: demoUserId('b') },
    ]) {
      expect(holdStatements({ ...held, userIds })).toEqual([])
    }
  })

  it('refuses an identity that names nobody, rather than filing it', () => {
    for (const userIds of [
      { orderer: '', receiver: '' },
      { orderer: 'user-robb', receiver: DANA },
      { orderer: ROBB, receiver: 'demo:' },
    ]) {
      expect(() => holdStatements({ ...held, userIds })).toThrow(UnauthenticIdentityError)
    }
  })
})

/** A fake D1 that fails its first `failures` batches, then succeeds. */
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

describe('writeHeldMatch', () => {
  it('files the hold on the first try when D1 is healthy', async () => {
    const { db, calls } = flakyDb(0)
    await writeHeldMatch(db, held)
    expect(calls.attempts).toBe(1)
    expect(calls.batched).toEqual([1])
  })

  it('retries a transient failure with the same backoff the other writes get', async () => {
    const { db, calls } = flakyDb(2)
    const { slept, sleep } = recordingSleep()
    await writeHeldMatch(db, held, { sleep })
    expect(calls.attempts).toBe(3)
    expect(slept).toEqual([200, 400])
  })

  it('rethrows once the attempts are exhausted, so the caller keeps the row', async () => {
    // The whole reason this throws rather than returning quietly: `fileHold`
    // parks the row for replay only because it can tell the write failed, and
    // until D1 has it there is no cross-cell trace of the money at all.
    const { db, calls } = flakyDb(Number.POSITIVE_INFINITY)
    const { sleep } = recordingSleep()
    await expect(writeHeldMatch(db, held, { sleep })).rejects.toThrow('D1_ERROR')
    expect(calls.attempts).toBe(3)
  })

  it('never touches D1 for a demo pairing, and does not retry its way to an error', async () => {
    const { db, calls } = flakyDb(Number.POSITIVE_INFINITY)
    const { slept, sleep } = recordingSleep()
    const pairing: HeldMatch = {
      ...held,
      userIds: { orderer: demoUserId('a'), receiver: demoUserId('b') },
    }
    await expect(writeHeldMatch(db, pairing, { sleep })).resolves.toBeUndefined()
    expect(calls.attempts).toBe(0)
    expect(slept).toEqual([])
  })

  it('refuses an unauthentic identity without touching D1 or retrying', async () => {
    const { db, calls } = flakyDb(0)
    const nobody: HeldMatch = { ...held, userIds: { orderer: '', receiver: '' } }
    await expect(writeHeldMatch(db, nobody)).rejects.toThrow(UnauthenticIdentityError)
    expect(calls.attempts).toBe(0)
  })
})

/**
 * The half of this a pure function cannot see (`worker/pool.ts`, `worker/admin.ts`).
 *
 * Every acceptance criterion here is an *ordering* or a *reachability*, and both
 * are invisible to a unit test over the pieces: a `writeHeldMatch` with a green
 * test and no call site is this repo's recurring defect (the late-refund branch
 * was correct and unreachable for the whole life of the payment feature). So the
 * behaviour is proved end to end by `scripts/payment-gate-check.mjs`, and the
 * structure that keeps it reachable is asserted here.
 */
describe('a hold reaches D1 before the money leaves the cell', () => {
  const bodyOf = (source: string, signature: string): string => {
    const from = source.indexOf(signature)
    expect(from, `${signature} not found`).toBeGreaterThan(-1)
    const rest = source.slice(from)
    return rest.slice(0, rest.indexOf('\n  }\n'))
  }

  it('files the hold inside retireMatch, before the record is deleted', () => {
    const body = bodyOf(poolSource, 'private async retireMatch(')
    expect(body).toContain('this.fileHold(heldMatchFrom(record, tombstone, held))')
    expect(body.indexOf('this.fileHold(')).toBeLessThan(body.indexOf('storage.delete(`match:'))
  })

  it('and only for money that is actually held, from a teardown nobody disputed', () => {
    const body = bodyOf(poolSource, 'private async retireMatch(')
    expect(body).toContain('const held = parseHoldReason(reason)')
    expect(body).toContain('holdsCollectedMoney(tombstone.ledger)')
  })

  it('makes every teardown path name itself, so a new one cannot forget', () => {
    // `retireMatch` takes a required third argument. Enumerated from the source
    // rather than listed here: a fifth call site that passed nothing would not
    // compile, and one that passed a reason nobody catalogued is caught below.
    const calls = poolSource.match(/this\.retireMatch\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(6)
    for (const call of calls) {
      expect(call.split(',')).toHaveLength(3)
    }
  })

  it('and every non-dispute teardown in the catalogue is a call site that uses it', () => {
    for (const reason of HOLD_REASONS) {
      expect(poolSource, `no teardown passes '${reason}' to retireMatch`).toContain(`retireMatch(`)
      expect(poolSource).toContain(`'${reason}')`)
    }
    // The two that deliberately file nothing still say so by name.
    expect(poolSource).toContain("retireMatch(record.matchId, record, 'settled')")
    expect(poolSource).toContain("retireMatch(record.matchId, record, 'disputed')")
  })

  it('keeps the row when D1 refused it, and replays it off the alarm', () => {
    // The same discipline `persistTerminal` follows, in the one place it could
    // not be reused: a hold is filed for a `pending` record, which
    // `reconcileTerminal` skips by design.
    const file = bodyOf(poolSource, 'private async fileHold(')
    expect(file).toContain('catch (error)')
    expect(file).toContain('PENDING_HOLD_PREFIX')
    expect(file).toContain('storage.put<HeldMatch>')
    const alarm = bodyOf(poolSource, 'override async alarm(')
    expect(alarm).toContain('this.reconcileHolds()')
    const reconcile = bodyOf(poolSource, 'private async reconcileHolds(')
    expect(reconcile).toContain('PENDING_HOLD_PREFIX')
    expect(reconcile).toContain('this.fileHold(held)')
  })

  it('never lets a retry reach a socket or a pickup code', () => {
    // Same rule as the tombstone handler and the dispute resolution: money is
    // money, and it must not be a second route to a code or a settled row.
    const body = bodyOf(poolSource, 'private async handleHoldRetry(')
    expect(body).toContain('parseHoldRetryRequest(')
    expect(body).not.toContain('pickupCode')
    expect(body).not.toContain('matchSockets')
    expect(body).not.toContain('completeMatch')
  })

  it('reaches that retry from the Durable Object fetch, not merely defines it', () => {
    const fetchBody = bodyOf(poolSource, 'override async fetch(')
    expect(fetchBody).toContain('INTERNAL_HOLD_PATH')
    expect(fetchBody).toContain('this.handleHoldRetry(request)')
  })
})

describe('the operator surface for holds', () => {
  it('lists and retries behind the same allowlist the disputes queue is behind', () => {
    for (const route of ["adminRoutes.get('/holds'", "adminRoutes.post('/holds/:matchId/retry'"]) {
      const from = adminSource.indexOf(route)
      expect(from, `${route} not found in worker/admin.ts`).toBeGreaterThan(-1)
      const body = adminSource.slice(from, adminSource.indexOf('\n})', from))
      expect(body).toContain('await operatorOf(c.env, c.req.raw)')
      // The same 404 an unknown path gets. A 401 or a 403 would tell a
      // signed-in buyer poking at /api/admin/* that the route exists.
      expect(body).toContain('return c.json(notFound, 404)')
    }
  })

  it('stamps what a retry recovered only after Stripe has answered', () => {
    const from = adminSource.indexOf("adminRoutes.post('/holds/:matchId/retry'")
    const body = adminSource.slice(from, adminSource.indexOf('\n})', from))
    expect(body.indexOf('retryHold(')).toBeLessThan(body.indexOf('stampHoldRefund('))
    // A retry that could not be attempted leaves the row untouched rather than
    // stamping a refund nobody asked for — `refunded_cents` stays NULL, which
    // is not 0.
    expect(body).toMatch(/if \(money === null\)[\s\S]*?502/)
    expect(body.indexOf('502')).toBeLessThan(body.indexOf('stampHoldRefund('))
  })

  it('never touches a dispute row from a hold route, or the reverse', () => {
    // The parallel-surface criterion, asserted on the *calls* rather than on
    // the prose: a hold route that could reach `claimDispute` would let a
    // refused refund resolve a decision nobody made.
    const holds = adminSource.slice(
      adminSource.indexOf("adminRoutes.get('/holds'"),
      adminSource.indexOf('async function retryHold('),
    )
    for (const call of [
      'listDisputes(',
      'getDispute(',
      'claimDispute(',
      'stampDisputeRefund(',
      'settleResolution(',
    ]) {
      expect(holds, `a hold route calls ${call}`).not.toContain(`await ${call}`)
    }
    const disputes = adminSource.slice(
      adminSource.indexOf("adminRoutes.get('/disputes'"),
      adminSource.indexOf("adminRoutes.get('/holds'"),
    )
    for (const call of ['listHolds(', 'getHold(', 'stampHoldRefund(', 'retryHold(']) {
      expect(disputes, `a dispute route calls ${call}`).not.toContain(`await ${call}`)
    }
  })
})

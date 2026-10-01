import { afterEach, describe, expect, it, vi } from 'vitest'
import { findDeal } from '../shared/deals'
import { settle } from '../shared/economics'
import { honeypotUserId } from '../shared/honeypot'
import type { Env } from '../worker/env'
import app from '../worker/index'
import {
  allLegsPaid,
  applyPaymentOutcome,
  codeAtMatchTime,
  collectedCents,
  hasOutstandingMoney,
  markRefunded,
  openLedger,
  type PaymentLedger,
  type PaymentLeg,
  type PaymentTombstone,
  parsePaymentEventReport,
  parsePaymentOutcome,
  paymentDisposition,
  paymentIntentSpecs,
  refundableLegs,
  refundIdempotencyKey,
  retainedFeeCents,
  retireLedger,
  serverPaymentMode,
  totalCents,
} from '../worker/lib/payments'
import { NuggPool } from '../worker/pool'
import poolSource from '../worker/pool.ts?raw'

const RETIRED_AT = 1_700_000_000_000

/**
 * A ledger as it exists after its match record has been deleted — the only shape
 * a late payment event is ever folded into.
 */
function retired(ledger: PaymentLedger): PaymentLedger {
  const tombstone = retireLedger(ledger, RETIRED_AT)
  if (tombstone === null) throw new Error('fixture: expected a tombstone worth keeping')
  return tombstone.ledger
}

function dealOrThrow(dealId: string) {
  const deal = findDeal(dealId)
  if (deal === undefined) throw new Error(`fixture deal missing: ${dealId}`)
  return deal
}

const DEAL = dealOrThrow('mcd-nuggets-20')

const MATCH_ID = '4f8c2e1a-0b3d-4c5e-8f90-112233445566'
const CELL = '9q8yyk'

function specs() {
  return paymentIntentSpecs(settle(DEAL, 2), {
    matchId: MATCH_ID,
    cell: CELL,
    description: 'test split',
  })
}

function ledger(): PaymentLedger {
  return openLedger(settle(DEAL, 2), { matchId: MATCH_ID, cell: CELL }, [
    'pi_orderer',
    'pi_receiver',
  ])
}

describe('paymentIntentSpecs', () => {
  it('charges each buyer exactly their settlement share', () => {
    const settlement = settle(DEAL, 2)
    const amounts = specs().map((s) => s.amountCents)
    expect(amounts).toEqual(settlement.shares.map((s) => s.payCents))
    expect(amounts).toEqual([449, 449])
  })

  it('collects the box price plus the pairing fee, and nothing else', () => {
    const settlement = settle(DEAL, 2)
    const total = specs().reduce((sum, s) => sum + s.amountCents, 0)
    expect(total).toBe(settlement.totalCollectedCents)
    expect(total - settlement.cogsCents).toBe(settlement.platformFeeCents)
    expect(total - settlement.cogsCents).toBe(99)
  })

  it('takes $0.99 on every deal in the catalogue, whatever the box costs', () => {
    for (const dealId of ['mcd-nuggets-20', 'wendys-nuggets-20', 'bk-nuggets-20']) {
      const settlement = settle(dealOrThrow(dealId), 2)
      const total = paymentIntentSpecs(settlement, {
        matchId: MATCH_ID,
        cell: CELL,
        description: 'x',
      }).reduce((sum, s) => sum + s.amountCents, 0)
      expect(total - settlement.cogsCents).toBe(99)
    }
  })

  it('keys idempotency on the match and role so a retry cannot double-charge', () => {
    expect(specs().map((s) => s.idempotencyKey)).toEqual([
      `${MATCH_ID}:orderer`,
      `${MATCH_ID}:receiver`,
    ])
    // Rebuilding the specs for the same match yields the same keys, which is
    // what makes a retried match message safe.
    expect(specs().map((s) => s.idempotencyKey)).toEqual(specs().map((s) => s.idempotencyKey))
  })

  it('tags each intent with the cell, so a webhook can find the owning pool', () => {
    for (const spec of specs()) {
      expect(spec.metadata).toEqual({
        match_id: MATCH_ID,
        role: spec.role,
        deal_id: 'mcd-nuggets-20',
        cell: CELL,
      })
    }
  })

  it('charges in whole cents only', () => {
    for (const spec of specs()) expect(Number.isInteger(spec.amountCents)).toBe(true)
  })
})

describe('retainedFeeCents', () => {
  it('books nothing until both halves are in', () => {
    const opened = ledger()
    expect(retainedFeeCents(opened)).toBe(0)

    const half = applyPaymentOutcome(opened, {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    }).ledger
    expect(collectedCents(half)).toBe(449)
    expect(retainedFeeCents(half)).toBe(0)
  })

  it('books $0.99 once both halves clear', () => {
    let state = ledger()
    for (const [role, id] of [
      ['orderer', 'pi_orderer'],
      ['receiver', 'pi_receiver'],
    ] as const) {
      state = applyPaymentOutcome(state, {
        matchId: MATCH_ID,
        role,
        paymentIntentId: id,
        outcome: 'succeeded',
      }).ledger
    }
    expect(collectedCents(state)).toBe(898)
    expect(retainedFeeCents(state)).toBe(99)
    expect(collectedCents(state) - state.cogsCents).toBe(99)
  })
})

describe('applyPaymentOutcome', () => {
  it('holds the pickup code back while one half is outstanding', () => {
    const { effect } = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    expect(effect).toEqual({ kind: 'pending' })
  })

  it('releases the pickup code only when the second half lands', () => {
    const first = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    const second = applyPaymentOutcome(first.ledger, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    expect(second.effect).toEqual({ kind: 'cleared' })
    expect(allLegsPaid(second.ledger)).toBe(true)
  })

  it('refunds the paying buyer and kills the match when the other half declines', () => {
    const paid = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    }).ledger

    const { ledger: after, effect } = applyPaymentOutcome(paid, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'failed',
    })

    expect(effect.kind).toBe('unwind')
    if (effect.kind !== 'unwind') throw new Error('expected an unwind')
    expect(effect.failedRole).toBe('receiver')
    expect(effect.refund.map((leg) => leg.paymentIntentId)).toEqual(['pi_orderer'])
    expect(effect.refund[0].amountCents).toBe(449)

    // What is OWED, not what has been handed back. The leg stays `succeeded`
    // until Stripe confirms, because until then the money really is still
    // collected — a ledger that says `refunded` before the call is a ledger that
    // lies whenever the call fails.
    expect(after.legs.find((l) => l.role === 'orderer')?.status).toBe('succeeded')
    expect(after.legs.find((l) => l.role === 'receiver')?.status).toBe('failed')
    expect(collectedCents(after)).toBe(449)

    // Nothing is retained from a one-sided collection, and once the refund is
    // confirmed nothing is collected either.
    const settled = markRefunded(after, effect.refund)
    expect(settled.legs.find((l) => l.role === 'orderer')?.status).toBe('refunded')
    expect(collectedCents(settled)).toBe(0)
    expect(retainedFeeCents(settled)).toBe(0)
  })

  it('leaves a leg whose refund the processor refused looking like money owed', () => {
    const paid = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    }).ledger
    const { ledger: after, effect } = applyPaymentOutcome(paid, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'failed',
    })
    if (effect.kind !== 'unwind') throw new Error('expected an unwind')

    // Stripe confirmed nothing: `markRefunded` is handed an empty set, which is
    // what `NuggPool.refund` returns when every call throws.
    const stuck = markRefunded(after, [])
    expect(stuck.legs.find((l) => l.role === 'orderer')?.status).toBe('succeeded')
    expect(collectedCents(stuck)).toBe(449)
    // And the tombstone is kept, because that 449 is the evidence of money held.
    expect(retireLedger(stuck, RETIRED_AT)).not.toBeNull()
  })

  it('has nothing to refund when the first half is the one that fails', () => {
    const { effect } = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'failed',
    })
    expect(effect).toEqual({ kind: 'unwind', failedRole: 'orderer', refund: [] })
  })

  it('refunds a payment that lands after the match is already dead', () => {
    // The orderer's card declines, the match is unwound, and the record is
    // deleted — leaving the tombstone `retireLedger` produced. Driven through
    // that shape deliberately: this used to be asserted against a hand-built
    // ledger with a failed leg in it, which no live path could ever produce
    // because the record was gone, so the test stayed green while the branch it
    // covered was unreachable from its only caller. If `retireLedger` stops
    // closing the ledger, this goes red instead of staying quietly correct.
    const dead = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'failed',
    }).ledger

    const late = applyPaymentOutcome(retired(dead), {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    expect(late.effect.kind).toBe('late_refund')
    if (late.effect.kind !== 'late_refund') throw new Error('expected a late refund')
    expect(late.effect.refund.map((l: PaymentLeg) => l.paymentIntentId)).toEqual(['pi_receiver'])
    // Owed, and collected until the refund is confirmed.
    expect(collectedCents(late.ledger)).toBe(449)
    expect(collectedCents(markRefunded(late.ledger, late.effect.refund))).toBe(0)
  })

  it('refunds a leg that lands after a match was cancelled with both halves pending', () => {
    // The shape a cancellation leaves: no leg failed, so "some other leg looks
    // dead" would miss it — and this half would have been folded into a match
    // that no longer exists, then the second one would have CLEARED it.
    const tombstone = retired(ledger())
    const first = applyPaymentOutcome(tombstone, {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    expect(first.effect.kind).toBe('late_refund')

    const second = applyPaymentOutcome(first.ledger, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    expect(second.effect.kind).toBe('late_refund')
    expect(allLegsPaid(second.ledger)).toBe(true)
    // Both halves landed, and neither cleared anything: a retired match has no
    // code to release and no row to book.
    expect(second.effect).not.toEqual({ kind: 'cleared' })
  })

  it('absorbs a replayed webhook instead of clearing or refunding twice', () => {
    const first = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    const replay = applyPaymentOutcome(first.ledger, {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    expect(replay.effect).toEqual({ kind: 'noop', reason: 'already_final' })
    expect(collectedCents(replay.ledger)).toBe(449)

    const cleared = applyPaymentOutcome(first.ledger, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    const clearedReplay = applyPaymentOutcome(cleared.ledger, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    expect(clearedReplay.effect).toEqual({ kind: 'noop', reason: 'already_final' })
    expect(collectedCents(clearedReplay.ledger)).toBe(898)
  })

  it('ignores an event for a PaymentIntent this match does not own', () => {
    const { effect } = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_somebody_else',
      outcome: 'succeeded',
    })
    expect(effect).toEqual({ kind: 'noop', reason: 'unknown_leg' })
  })

  it('ignores a second failure on an already-dead match', () => {
    const dead = retired(
      applyPaymentOutcome(ledger(), {
        matchId: MATCH_ID,
        role: 'orderer',
        paymentIntentId: 'pi_orderer',
        outcome: 'failed',
      }).ledger,
    )
    const second = applyPaymentOutcome(dead, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'failed',
    })
    expect(second.effect).toEqual({ kind: 'noop', reason: 'match_over' })
  })
})

describe('refundableLegs', () => {
  it('names what was collected when a buddy walks away', () => {
    const paid = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    }).ledger
    const owed = refundableLegs(paid)
    expect(owed.map((l) => l.role)).toEqual(['orderer'])
    // Naming what is owed does not itself hand anything back.
    expect(collectedCents(paid)).toBe(449)
    expect(collectedCents(markRefunded(paid, owed))).toBe(0)
    expect(retainedFeeCents(markRefunded(paid, owed))).toBe(0)
  })

  it('is empty when nobody has paid yet', () => {
    expect(refundableLegs(ledger())).toEqual([])
  })
})

describe('markRefunded', () => {
  it('stamps only the legs a refund was confirmed for', () => {
    const both = applyPaymentOutcome(
      applyPaymentOutcome(ledger(), {
        matchId: MATCH_ID,
        role: 'orderer',
        paymentIntentId: 'pi_orderer',
        outcome: 'succeeded',
      }).ledger,
      {
        matchId: MATCH_ID,
        role: 'receiver',
        paymentIntentId: 'pi_receiver',
        outcome: 'succeeded',
      },
    ).ledger

    const owed = refundableLegs(both)
    expect(owed).toHaveLength(2)
    // One call succeeded, the other threw. Only the confirmed leg moves.
    const partial = markRefunded(
      both,
      owed.filter((leg) => leg.role === 'orderer'),
    )
    expect(partial.legs.find((l) => l.role === 'orderer')?.status).toBe('refunded')
    expect(partial.legs.find((l) => l.role === 'receiver')?.status).toBe('succeeded')
    expect(collectedCents(partial)).toBe(449)
  })
})

describe('retireLedger', () => {
  it('keeps a tombstone while a leg can still land', () => {
    const dead = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'failed',
    }).ledger
    const tombstone = retireLedger(dead, RETIRED_AT)
    expect(tombstone).not.toBeNull()
    expect(tombstone?.matchId).toBe(MATCH_ID)
    expect(tombstone?.ledger.closedAt).toBe(RETIRED_AT)
    expect(hasOutstandingMoney(dead)).toBe(true)
  })

  it('keeps nothing when every leg is final and nothing is held', () => {
    const paid = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    }).ledger
    const { effect } = applyPaymentOutcome(paid, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'failed',
    })
    if (effect.kind !== 'unwind') throw new Error('expected an unwind')
    const failedAndRefunded = markRefunded(
      applyPaymentOutcome(paid, {
        matchId: MATCH_ID,
        role: 'receiver',
        paymentIntentId: 'pi_receiver',
        outcome: 'failed',
      }).ledger,
      effect.refund,
    )
    expect(hasOutstandingMoney(failedAndRefunded)).toBe(false)
    expect(retireLedger(failedAndRefunded, RETIRED_AT)).toBeNull()
  })

  it('carries the charges and nothing that could reach a code or a ledger row', () => {
    const tombstone = retireLedger(ledger(), RETIRED_AT)
    // The shape is the guarantee: a tombstone is money, never a match. There is
    // no pickupCode to leak, no disposition for `pickupUnlocked` to read, and no
    // settlement for `writeSettledMatch` to book.
    expect(Object.keys(tombstone ?? {}).sort()).toEqual(['ledger', 'matchId', 'retiredAt'])
    expect(JSON.stringify(tombstone)).not.toContain('pickupCode')
    expect(JSON.stringify(tombstone)).not.toContain('settlement')
  })
})

/**
 * The half of this that a pure function cannot see.
 *
 * `applyPaymentOutcome`'s late-refund branch was correct, unit-tested and green
 * for the whole life of the payment feature while being unreachable from its only
 * caller — every teardown path deleted the match record, so the webhook that
 * would have reached it was answered `unknown_match` and a real buyer kept losing
 * $4.49. That is the fourth predicate in this repo to enforce nothing because
 * nobody called it, and a test that asserts behaviour without asserting
 * reachability is how all four survived review.
 *
 * So: the behaviour is proved end-to-end through a socket by
 * `scripts/payment-gate-check.mjs` (the charged lane), and the *structure* that
 * keeps it reachable is asserted here. This goes red if a new teardown path
 * deletes a match record without leaving its money behind.
 */
describe('the late-refund path stays reachable from worker/pool.ts', () => {
  const pool = poolSource

  it('deletes a match record in exactly one place', () => {
    const deletions = pool.match(/storage\.delete\(`match:/g) ?? []
    expect(deletions).toHaveLength(1)
  })

  it('and that place is retireMatch, which writes the tombstone first', () => {
    const retire = pool.slice(pool.indexOf('private async retireMatch('))
    const body = retire.slice(0, retire.indexOf('\n  }\n'))
    expect(body).toContain('retireLedger(')
    expect(body).toContain('TOMBSTONE_PREFIX')
    expect(body).toContain('storage.delete(`match:')
    // The tombstone is written before the record goes, not after.
    expect(body.indexOf('TOMBSTONE_PREFIX')).toBeLessThan(body.indexOf('storage.delete(`match:'))
  })

  it('and a settled split leaves no tombstone, because its money is earned', () => {
    // A settled match's legs are all `succeeded`, so `retireLedger` would happily
    // build a tombstone for one — and `sweepTombstones` never drops a tombstone
    // holding collected cents, by design. Every completed split would therefore
    // leave a permanent record claiming this pool owes somebody money it does
    // not. Derived from the record's own status rather than a caller's flag.
    const retire = pool.slice(pool.indexOf('private async retireMatch('))
    const body = retire.slice(0, retire.indexOf('\n  }\n'))
    expect(body).toContain("const earned = record?.status === 'complete'")
    expect(body).toMatch(/record\?\.ledger === undefined \|\| earned \? null : retireLedger\(/)
  })

  it('and a payment event for a vanished match consults the tombstone', () => {
    const handler = pool.slice(pool.indexOf('private async handleLatePaymentEvent('))
    const body = handler.slice(0, handler.indexOf('\n  }\n'))
    expect(body).toContain('TOMBSTONE_PREFIX')
    expect(body).toContain('applyPaymentOutcome(')
    // Reached rather than merely defined: the live handler hands off to it before
    // it can answer `unknown_match`.
    const live = pool.slice(pool.indexOf('private async handlePaymentEvent('))
    expect(live.slice(0, live.indexOf('\n  }\n'))).toContain('this.handleLatePaymentEvent(outcome)')
  })

  it('and a tombstone can never release a pickup code', () => {
    const handler = pool.slice(pool.indexOf('private async handleLatePaymentEvent('))
    const body = handler.slice(0, handler.indexOf('\n  }\n'))
    expect(body).not.toContain('releasePickupCode')
    expect(body).not.toContain('pickupCode')
    expect(body).not.toContain('matchSockets')
  })
})

/**
 * What the money did, as seen from outside the Durable Object.
 *
 * Driven through the real `/api/stripe/webhook` route — signature verification,
 * `parsePaymentEvent`, the stub Durable Object namespace, `NuggPool.fetch`, and
 * back out as the HTTP body Stripe's delivery receives. Calling the reducer and
 * asserting its `refundedCents` is exactly the test that was already green while
 * no caller could reach the branch (#19), so it is the route that is asserted
 * here and nothing else.
 *
 * A tombstone lives in one cell's storage and there is no registry of live cells,
 * so this response is the only place a late refund's outcome is observable at
 * all: a refund Stripe confirmed and a refund Stripe refused used to be the same
 * `{ ok: true, handled: true }`.
 */
describe('POST /api/stripe/webhook reports what happened to late money', () => {
  const WEBHOOK_SECRET = 'whsec_issue_95'
  // Never reached: the refund call is a stubbed global `fetch`. Set so the pool
  // believes Stripe is configured and actually attempts one.
  const STRIPE_API_BASE = 'https://stripe.invalid/v1'
  const RECEIVER_SHARE = settle(DEAL, 2).shares[1].payCents

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Stripe's `/refunds`, answering however the case under test needs it to, and
   * recording which intent was asked about at which endpoint — a refund nobody
   * asked for and a refund asked for at the wrong URL both read as "held".
   */
  function stubStripe(status: number) {
    const asked: string[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const intent = new URLSearchParams(String(init?.body)).get('payment_intent')
      asked.push(`${String(url)} ${intent}`)
      const body = status === 200 ? { id: 're_1' } : { error: { message: 'no' } }
      return Response.json(body, { status })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)
    return asked
  }

  /**
   * A cell holding whatever this match left behind, behind the Durable Object
   * namespace the route resolves `cell` through. The real pool class, not a
   * stand-in for it — the storage `Map` is the only stub, and nothing asserts
   * about the `Map` itself beyond how many of this match's keys survive.
   */
  function poolEnv(seed: Array<[string, unknown]>) {
    const cell = new Map<string, unknown>(seed)
    const ctx = {
      getWebSockets: () => [],
      storage: {
        get: async (key: string) => cell.get(key),
        put: async (key: string, value: unknown) => void cell.set(key, value),
        delete: async (key: string) => cell.delete(key),
        list: async ({ prefix }: { prefix: string }) =>
          new Map([...cell].filter(([key]) => key.startsWith(prefix))),
        getAlarm: async () => null,
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
    }
    const secrets = {
      STRIPE_SECRET_KEY: 'sk_test_issue_95',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE,
    }
    const pool = new NuggPool(ctx as unknown as DurableObjectState, secrets as unknown as Env)
    return {
      cell,
      env: { ...secrets, NUGG_POOL: { idFromName: (name: string) => name, get: () => pool } },
    }
  }

  async function signature(payload: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000)
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const digest = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    )
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    return `t=${timestamp},v1=${hex}`
  }

  /** The receiver's card clearing behind 3DS, against a match that is gone. */
  async function deliverReceiverSuccess(env: Record<string, unknown>) {
    const payload = JSON.stringify({
      id: 'evt_late_success',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_receiver',
          amount: RECEIVER_SHARE,
          metadata: { match_id: MATCH_ID, role: 'receiver', cell: CELL },
        },
      },
    })
    const response = await app.request(
      new Request('http://localhost/api/stripe/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': await signature(payload),
        },
        body: payload,
      }),
      undefined,
      env,
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  /** The orderer declined, the match was torn down, the receiver is still open. */
  function afterDecline(): PaymentTombstone {
    const base = ledger()
    const legs = base.legs.map((leg) =>
      leg.role === 'orderer' ? { ...leg, status: 'failed' as const } : leg,
    )
    const tombstone = retireLedger({ ...base, legs }, RETIRED_AT)
    if (tombstone === null) throw new Error('fixture: expected a tombstone worth keeping')
    return tombstone
  }

  /** The ordinary late path: the record is gone and only its money is left. */
  function tombstoned(): Array<[string, unknown]> {
    return [[`paytomb:${MATCH_ID}`, afterDecline()]]
  }

  /**
   * The *other* late path: a live `match:` record whose ledger is already closed.
   *
   * `retireMatch` writes the tombstone and deletes the record in one tick, so
   * this shape should not exist — which is exactly why its branch needs driving
   * from outside. Only `ledger` is read on it (`handlePaymentEvent` refunds and
   * writes `{ ...record, ledger }` back), so the rest of a `MatchRecord` is
   * deliberately absent rather than faked: a field this fixture invented would be
   * a field the test could start asserting about.
   */
  function liveRecordAlreadyClosed(): Array<[string, unknown]> {
    return [[`match:${MATCH_ID}`, { matchId: MATCH_ID, ledger: afterDecline().ledger }]]
  }

  it('says the money went back, and how much, when Stripe confirms the refund', async () => {
    const asked = stubStripe(200)
    const { env, cell } = poolEnv(tombstoned())

    const { status, body } = await deliverReceiverSuccess(env)

    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      handled: true,
      effect: 'late_refund',
      late: true,
      refundedCents: RECEIVER_SHARE,
      heldCents: 0,
    })
    expect(asked).toEqual([`${STRIPE_API_BASE}/refunds pi_receiver`])
    // Nothing left to land and nothing left owed, so the tombstone is gone.
    expect(cell.size).toBe(0)
  })

  it('says the money is held, and how much, when Stripe refuses the refund', async () => {
    const asked = stubStripe(500)
    const { env, cell } = poolEnv(tombstoned())

    const { status, body } = await deliverReceiverSuccess(env)

    // The distinction this whole route change exists for: same effect, same 200,
    // and the only difference is which of the two figures carries the money.
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      handled: true,
      effect: 'late_refund',
      late: true,
      refundedCents: 0,
      heldCents: RECEIVER_SHARE,
    })
    expect(asked).toEqual([`${STRIPE_API_BASE}/refunds pi_receiver`])
    // And the money is still remembered, so a retry has something to ask about.
    expect(cell.size).toBe(1)
  })

  it('never reports a refund it only attempted', async () => {
    // The rule #19 established for what a buyer is told, restated one layer out:
    // the figure comes from the legs Stripe answered for, so a refund call that
    // threw before any answer reports nothing refunded rather than the amount.
    vi.stubGlobal('fetch', (() => Promise.reject(new TypeError('network down'))) as typeof fetch)
    const { env } = poolEnv(tombstoned())

    const { body } = await deliverReceiverSuccess(env)

    expect(body.refundedCents).toBe(0)
    expect(body.heldCents).toBe(RECEIVER_SHARE)
  })

  it('reports a live record whose ledger is closed exactly as a tombstone', async () => {
    // The two late-refund branches are a different handler each, and before this
    // the live-record one answered `{ ok, effect }` with no money on it at all.
    // Asserted against the tombstone answer rather than against a literal, so the
    // two cannot drift apart again without this failing.
    const viaTombstone = await (async () => {
      stubStripe(500)
      const { body } = await deliverReceiverSuccess(poolEnv(tombstoned()).env)
      vi.unstubAllGlobals()
      return body
    })()

    stubStripe(500)
    const { env, cell } = poolEnv(liveRecordAlreadyClosed())
    const { status, body } = await deliverReceiverSuccess(env)

    expect(status).toBe(200)
    expect(body).toEqual(viaTombstone)
    expect(body.heldCents).toBe(RECEIVER_SHARE)
    // The record is still the record — this handler refunds, it never retires.
    expect([...cell.keys()]).toEqual([`match:${MATCH_ID}`])
  })

  it('carries no money figures for a live match, and says so with late: false', async () => {
    // The other half of the unification: a live leg's money is reported to the
    // two buyers over their own sockets, so repeating an amount here would be a
    // second channel for it. `late: false` is what tells a reader that the
    // absence is deliberate rather than the old flat acknowledgement.
    const asked = stubStripe(200)
    const { env } = poolEnv([[`match:${MATCH_ID}`, { matchId: MATCH_ID, ledger: ledger() }]])

    const { status, body } = await deliverReceiverSuccess(env)

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, handled: true, effect: 'pending', late: false })
    // Nothing was refunded, because nothing is over.
    expect(asked).toEqual([])
  })

  it('tells a late event for a match this pool never had apart from a refund', async () => {
    stubStripe(200)
    const { env } = poolEnv([])

    const { status, body } = await deliverReceiverSuccess(env)

    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      handled: true,
      effect: 'unknown_match',
      late: true,
      refundedCents: 0,
      heldCents: 0,
    })
  })

  it('falls back to a plain acknowledgement when the pool answers unreadably', async () => {
    stubStripe(200)
    const { env } = poolEnv([])
    // A late answer missing half its money is the ambiguity the report exists to
    // remove, so the route must not repeat it.
    const unreadable = () => Response.json({ ok: true, effect: 'late_refund', late: true })
    const broken = {
      ...env,
      NUGG_POOL: { idFromName: () => 'x', get: () => ({ fetch: unreadable }) },
    }

    const { status, body } = await deliverReceiverSuccess(
      broken as unknown as Record<string, unknown>,
    )

    // A 200 with no money figures is the honest answer to a body the route
    // cannot read — never half a report, and never a fabricated zero.
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, handled: true })
  })
})

describe('totalCents', () => {
  it('sums both roles, where centsFor answers for one', () => {
    const settlement = settle(DEAL, 2)
    expect(totalCents(ledger().legs)).toBe(settlement.totalCollectedCents)
    expect(totalCents([])).toBe(0)
  })
})

describe('parsePaymentEventReport', () => {
  it('reads back every answer the pool can give', () => {
    expect(parsePaymentEventReport({ ok: true, effect: 'cleared', late: false })).toEqual({
      effect: 'cleared',
      late: false,
    })
    expect(
      parsePaymentEventReport({
        ok: true,
        effect: 'late_refund',
        late: true,
        refundedCents: 449,
        heldCents: 0,
      }),
    ).toEqual({ effect: 'late_refund', late: true, refundedCents: 449, heldCents: 0 })
  })

  it('refuses a late answer missing either half of the money', () => {
    // Half a report is the ambiguity the report exists to remove: a caller that
    // read `refundedCents` off one and nothing off the other would be guessing.
    for (const partial of [
      { effect: 'late_refund', late: true, refundedCents: 449 },
      { effect: 'late_refund', late: true, heldCents: 449 },
      { effect: 'late_refund', late: true, refundedCents: 449, heldCents: null },
      { effect: 'late_refund', late: true, refundedCents: 4.49, heldCents: 0 },
      { effect: 'late_refund', late: true, refundedCents: -449, heldCents: 0 },
    ]) {
      expect(parsePaymentEventReport(partial)).toBeNull()
    }
  })

  it('refuses an effect it does not know, including one off the prototype', () => {
    for (const effect of ['refunded', '', 'constructor', 'toString', '__proto__', 7]) {
      expect(parsePaymentEventReport({ effect, late: false })).toBeNull()
    }
  })

  it('refuses anything not shaped like an answer at all', () => {
    for (const bad of [null, undefined, 'late_refund', [], { effect: 'cleared' }]) {
      expect(parsePaymentEventReport(bad)).toBeNull()
    }
  })
})

describe('refundIdempotencyKey', () => {
  it('is stable per match and role, so a refund cannot be issued twice', () => {
    expect(refundIdempotencyKey(MATCH_ID, 'orderer')).toBe(`refund:${MATCH_ID}:orderer`)
    expect(refundIdempotencyKey(MATCH_ID, 'orderer')).not.toBe(
      refundIdempotencyKey(MATCH_ID, 'receiver'),
    )
  })
})

describe('parsePaymentOutcome', () => {
  const good = {
    matchId: MATCH_ID,
    role: 'orderer',
    paymentIntentId: 'pi_1',
    outcome: 'succeeded',
  }

  it('accepts a well-formed outcome', () => {
    expect(parsePaymentOutcome(JSON.stringify(good))).toEqual(good)
  })

  it('rejects malformed json and non-objects', () => {
    expect(parsePaymentOutcome('nope')).toBeNull()
    expect(parsePaymentOutcome('null')).toBeNull()
    expect(parsePaymentOutcome('[]')).toBeNull()
  })

  it('rejects an unknown role or outcome', () => {
    expect(parsePaymentOutcome(JSON.stringify({ ...good, role: 'admin' }))).toBeNull()
    expect(parsePaymentOutcome(JSON.stringify({ ...good, outcome: 'refunded' }))).toBeNull()
  })

  it('rejects missing identifiers', () => {
    expect(parsePaymentOutcome(JSON.stringify({ ...good, matchId: '' }))).toBeNull()
    expect(parsePaymentOutcome(JSON.stringify({ ...good, paymentIntentId: 7 }))).toBeNull()
  })
})

/**
 * The money gate, enumerated rather than sampled.
 *
 * Every combination of "are the secrets bound", "did an operator opt into
 * uncharged pairing" and "is either buyer a demo identity" is listed, because the
 * dangerous cell in this table is the one nobody thought to write down: secrets
 * absent, no opt-in, two real buyers — which must refuse, not clear for free.
 */
describe('paymentDisposition', () => {
  const REAL_A = '9f1c2b3d-0000-4000-8000-000000000001'
  const REAL_B = '9f1c2b3d-0000-4000-8000-000000000002'
  const DEMO = 'demo:0f0e0d0c-0000-4000-8000-000000000003'
  const DECOY = honeypotUserId('1a2b3c4d-0000-4000-8000-000000000004')

  const cases: {
    stripeConfigured: boolean
    unchargedAllowed: boolean
    userIds: { orderer: string; receiver: string }
    expected: 'charge' | 'honeypot' | 'demo' | 'uncharged' | 'refuse'
  }[] = [
    // Two real buyers: the only thing that decides is the server's own config.
    {
      stripeConfigured: true,
      unchargedAllowed: false,
      userIds: { orderer: REAL_A, receiver: REAL_B },
      expected: 'charge',
    },
    {
      stripeConfigured: true,
      unchargedAllowed: true,
      userIds: { orderer: REAL_A, receiver: REAL_B },
      expected: 'charge',
    },
    {
      stripeConfigured: false,
      unchargedAllowed: true,
      userIds: { orderer: REAL_A, receiver: REAL_B },
      expected: 'uncharged',
    },
    {
      stripeConfigured: false,
      unchargedAllowed: false,
      userIds: { orderer: REAL_A, receiver: REAL_B },
      expected: 'refuse',
    },
    // A demo identity on either side, under every server configuration.
    {
      stripeConfigured: true,
      unchargedAllowed: false,
      userIds: { orderer: DEMO, receiver: REAL_B },
      expected: 'demo',
    },
    {
      stripeConfigured: true,
      unchargedAllowed: false,
      userIds: { orderer: REAL_A, receiver: DEMO },
      expected: 'demo',
    },
    {
      stripeConfigured: true,
      unchargedAllowed: true,
      userIds: { orderer: DEMO, receiver: DEMO },
      expected: 'demo',
    },
    {
      stripeConfigured: false,
      unchargedAllowed: false,
      userIds: { orderer: DEMO, receiver: DEMO },
      expected: 'demo',
    },
    // A decoy on either side, under every server configuration. Enumerated the
    // same way the demo rows are, because the dangerous cell is again the one
    // nobody thought to write down: secrets bound, a real buyer on one side, and
    // a decoy on the other — which must never charge that real buyer for a
    // handoff that cannot happen.
    {
      stripeConfigured: true,
      unchargedAllowed: false,
      userIds: { orderer: REAL_A, receiver: DECOY },
      expected: 'honeypot',
    },
    {
      stripeConfigured: true,
      unchargedAllowed: false,
      userIds: { orderer: DECOY, receiver: REAL_B },
      expected: 'honeypot',
    },
    {
      stripeConfigured: true,
      unchargedAllowed: true,
      userIds: { orderer: REAL_A, receiver: DECOY },
      expected: 'honeypot',
    },
    {
      stripeConfigured: false,
      unchargedAllowed: true,
      userIds: { orderer: REAL_A, receiver: DECOY },
      expected: 'honeypot',
    },
    {
      stripeConfigured: false,
      unchargedAllowed: false,
      userIds: { orderer: REAL_A, receiver: DECOY },
      expected: 'honeypot',
    },
    // A decoy beside a demo identity is still a decoy: the honeypot branch is
    // answered first, and it has to be — `demo` releases a pickup code at match
    // time and a honeypot must never get one.
    {
      stripeConfigured: true,
      unchargedAllowed: false,
      userIds: { orderer: DEMO, receiver: DECOY },
      expected: 'honeypot',
    },
  ]

  for (const c of cases) {
    it(`is ${c.expected} with stripe=${c.stripeConfigured}, uncharged=${c.unchargedAllowed}, ids=${c.userIds.orderer.slice(0, 5)}/${c.userIds.receiver.slice(0, 5)}`, () => {
      expect(paymentDisposition(c)).toBe(c.expected)
    })
  }

  it('never charges a decoy pairing on a fully configured production deploy', () => {
    // The same ordering property the demo case relies on, and the one the issue
    // asks be proved on a *fully configured* deployment rather than on a laptop
    // with no secrets: identity is read before `stripeConfigured` is consulted,
    // so there is no configuration under which a decoy reaches Stripe.
    for (const stripeConfigured of [true, false]) {
      for (const unchargedAllowed of [true, false]) {
        for (const userIds of [
          { orderer: REAL_A, receiver: DECOY },
          { orderer: DECOY, receiver: REAL_B },
          { orderer: DECOY, receiver: DECOY },
        ]) {
          expect(paymentDisposition({ stripeConfigured, unchargedAllowed, userIds })).not.toBe(
            'charge',
          )
          expect(paymentDisposition({ stripeConfigured, unchargedAllowed, userIds })).toBe(
            'honeypot',
          )
        }
      }
    }
  })

  it('never charges a demo pair, even on a fully configured production deploy', () => {
    // The ordering property: demo is decided before the secrets are consulted, so
    // a stage demo on the live Worker cannot reach Stripe.
    expect(
      paymentDisposition({
        stripeConfigured: true,
        unchargedAllowed: false,
        userIds: { orderer: DEMO, receiver: REAL_A },
      }),
    ).toBe('demo')
  })

  it('will not let an uncharged opt-in disable a configured payment path', () => {
    expect(
      paymentDisposition({
        stripeConfigured: true,
        unchargedAllowed: true,
        userIds: { orderer: REAL_A, receiver: REAL_B },
      }),
    ).toBe('charge')
  })

  it('fails closed when a secret is missing and nobody said that was intentional', () => {
    expect(
      paymentDisposition({
        stripeConfigured: false,
        unchargedAllowed: false,
        userIds: { orderer: REAL_A, receiver: REAL_B },
      }),
    ).toBe('refuse')
  })
})

describe('codeAtMatchTime', () => {
  it('releases a code up front only when no money is in play', () => {
    expect(codeAtMatchTime('demo')).toBe(true)
    expect(codeAtMatchTime('uncharged')).toBe(true)
  })

  it('holds the code back for a match that is being charged', () => {
    expect(codeAtMatchTime('charge')).toBe(false)
  })

  it('never releases a code for a decoy pairing', () => {
    // The single `false` the whole feature's safety argument rests on. No code
    // released means `pickupUnlocked` is false forever, so `handleConfirmPickup`
    // refuses, so no confirmation is ever recorded — which makes a `matches` row
    // (needs both) and a `disputes` row (every route needs one) unreachable by
    // construction rather than by a timer firing in the right order.
    expect(codeAtMatchTime('honeypot')).toBe(false)
  })

  it('holds the code back for a match that cannot be charged at all', () => {
    // `refuse` never reaches a live match, but if it ever did, the answer that
    // costs a box is the wrong one.
    expect(codeAtMatchTime('refuse')).toBe(false)
  })
})

describe('serverPaymentMode', () => {
  it('reports the same precedence the disposition acts on', () => {
    expect(serverPaymentMode({ stripeConfigured: true, unchargedAllowed: false })).toBe('live')
    expect(serverPaymentMode({ stripeConfigured: true, unchargedAllowed: true })).toBe('live')
    expect(serverPaymentMode({ stripeConfigured: false, unchargedAllowed: true })).toBe('uncharged')
    expect(serverPaymentMode({ stripeConfigured: false, unchargedAllowed: false })).toBe(
      'unconfigured',
    )
  })
})

describe('allLegsPaid', () => {
  it('is false while a half is outstanding', () => {
    expect(allLegsPaid(ledger())).toBe(false)
  })

  it('is true only once every leg has actually succeeded', () => {
    const first = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    expect(allLegsPaid(first.ledger)).toBe(false)
    const second = applyPaymentOutcome(first.ledger, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    expect(allLegsPaid(second.ledger)).toBe(true)
  })

  it('is false again once a paid leg has been refunded', () => {
    const paid = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    })
    const unwound = markRefunded(paid.ledger, refundableLegs(paid.ledger))
    expect(allLegsPaid(unwound)).toBe(false)
  })

  it('refuses an empty ledger rather than vacuously clearing it', () => {
    expect(allLegsPaid({ ...ledger(), legs: [] })).toBe(false)
  })
})

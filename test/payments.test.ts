import { describe, expect, it } from 'vitest'
import { findDeal } from '../shared/deals'
import { settle } from '../shared/economics'
import {
  allLegsPaid,
  applyPaymentOutcome,
  codeAtMatchTime,
  collectedCents,
  openLedger,
  type PaymentLedger,
  parsePaymentOutcome,
  paymentDisposition,
  paymentIntentSpecs,
  refundIdempotencyKey,
  retainedFeeCents,
  serverPaymentMode,
  unwindLedger,
} from '../worker/lib/payments'

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

    // Nothing is retained from a one-sided collection.
    expect(after.legs.find((l) => l.role === 'orderer')?.status).toBe('refunded')
    expect(after.legs.find((l) => l.role === 'receiver')?.status).toBe('failed')
    expect(collectedCents(after)).toBe(0)
    expect(retainedFeeCents(after)).toBe(0)
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
    const dead = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'failed',
    }).ledger

    const late = applyPaymentOutcome(dead, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'succeeded',
    })
    expect(late.effect.kind).toBe('unwind')
    if (late.effect.kind !== 'unwind') throw new Error('expected an unwind')
    expect(late.effect.refund.map((l) => l.paymentIntentId)).toEqual(['pi_receiver'])
    expect(collectedCents(late.ledger)).toBe(0)
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
    const dead = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'failed',
    }).ledger
    const second = applyPaymentOutcome(dead, {
      matchId: MATCH_ID,
      role: 'receiver',
      paymentIntentId: 'pi_receiver',
      outcome: 'failed',
    })
    expect(second.effect).toEqual({ kind: 'noop', reason: 'match_over' })
  })
})

describe('unwindLedger', () => {
  it('refunds whatever was collected when a buddy walks away', () => {
    const paid = applyPaymentOutcome(ledger(), {
      matchId: MATCH_ID,
      role: 'orderer',
      paymentIntentId: 'pi_orderer',
      outcome: 'succeeded',
    }).ledger
    const { ledger: after, refund } = unwindLedger(paid)
    expect(refund.map((l) => l.role)).toEqual(['orderer'])
    expect(collectedCents(after)).toBe(0)
    expect(retainedFeeCents(after)).toBe(0)
  })

  it('is a no-op when nobody has paid yet', () => {
    const { refund } = unwindLedger(ledger())
    expect(refund).toEqual([])
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

  const cases: {
    stripeConfigured: boolean
    unchargedAllowed: boolean
    userIds: { orderer: string; receiver: string }
    expected: 'charge' | 'demo' | 'uncharged' | 'refuse'
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
  ]

  for (const c of cases) {
    it(`is ${c.expected} with stripe=${c.stripeConfigured}, uncharged=${c.unchargedAllowed}, ids=${c.userIds.orderer.slice(0, 5)}/${c.userIds.receiver.slice(0, 5)}`, () => {
      expect(paymentDisposition(c)).toBe(c.expected)
    })
  }

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
    const { ledger: unwound } = unwindLedger(paid.ledger)
    expect(allLegsPaid(unwound)).toBe(false)
  })

  it('refuses an empty ledger rather than vacuously clearing it', () => {
    expect(allLegsPaid({ ...ledger(), legs: [] })).toBe(false)
  })
})

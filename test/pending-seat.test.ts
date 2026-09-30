import { describe, expect, it } from 'vitest'
import { ACTIVE_DEALS } from '../shared/deals'
import { saucesForMerchant } from '../shared/sauces'
import { PENDING_SEAT_TTL_MS, parsePendingSeat } from '../src/hooks/pendingSeat'

/**
 * The seat a signed-out buyer was taking when the interstitial sent them to sign
 * in (#150). Read back off storage after a full-page round trip, so it is parsed
 * like any other untrusted value — and bounded in time, so it cannot take a seat
 * on the strength of a tap nobody remembers.
 */
const NOW = 1_800_000_000_000
// Off the catalogue, never typed: a sauce leaving the menu fails here first.
const [first, second] = saucesForMerchant(ACTIVE_DEALS[0]?.merchant ?? '')

describe('parsePendingSeat', () => {
  it('reads back a fresh intent', () => {
    expect(
      parsePendingSeat({ dealId: 'mcd-nuggets-20', sauces: null, at: NOW - 1_000 }, NOW),
    ).toEqual({ dealId: 'mcd-nuggets-20', sauces: null, at: NOW - 1_000 })
  })

  it('carries a real sauce pair through, and drops one that is not on any menu', () => {
    if (first === undefined || second === undefined) throw new Error('catalogue has no sauces')
    const kept = parsePendingSeat(
      { dealId: 'mcd-nuggets-20', sauces: [first.id, second.id], at: NOW },
      NOW,
    )
    expect(kept?.sauces).not.toBeNull()
    const dropped = parsePendingSeat(
      { dealId: 'mcd-nuggets-20', sauces: ['not-a-sauce', 'nor-this'], at: NOW },
      NOW,
    )
    expect(dropped?.dealId).toBe('mcd-nuggets-20')
    expect(dropped?.sauces).toBeNull()
  })

  it('expires, so a tab reopened tomorrow takes no seat', () => {
    expect(
      parsePendingSeat({ dealId: 'd', sauces: null, at: NOW - PENDING_SEAT_TTL_MS - 1 }, NOW),
    ).toBeNull()
    // A clock claiming the future is not an intent either.
    expect(parsePendingSeat({ dealId: 'd', sauces: null, at: NOW + 60_000 }, NOW)).toBeNull()
  })

  it('refuses anything that is not that shape', () => {
    for (const bogus of [
      null,
      'mcd-nuggets-20',
      {},
      { dealId: '', sauces: null, at: NOW },
      { dealId: 'd'.repeat(65), sauces: null, at: NOW },
      { dealId: 7, sauces: null, at: NOW },
      { dealId: 'd', sauces: null, at: 'now' },
      { dealId: 'd', sauces: null },
    ]) {
      expect(parsePendingSeat(bogus, NOW)).toBeNull()
    }
  })
})

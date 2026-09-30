import { describe, expect, it } from 'vitest'
import { ACTIVE_DEALS, DEALS, findDeal, INACTIVE_DEAL_IDS, isDealOffered } from '../shared/deals'

describe('the offered catalogue', () => {
  it('offers McDonald’s only', () => {
    expect(ACTIVE_DEALS.map((deal) => deal.id)).toEqual(['mcd-nuggets-20'])
  })

  it('keeps the full catalogue intact behind the gate', () => {
    // The deck's drift guard derives its figures from DEALS, and the cross-chain
    // spread is the evidence the pitch rests on. Gating what is offered must not
    // delete that data.
    expect(DEALS).toHaveLength(3)
    expect(DEALS.map((deal) => deal.merchant)).toEqual(["McDonald's", "Wendy's", 'Burger King'])
  })

  it('still resolves a gated deal by id', () => {
    // `findDeal` answers "does this deal exist", not "may it be chosen" — the
    // pool and the quote endpoint both depend on that distinction.
    expect(findDeal('wendys-nuggets-20')?.merchant).toBe("Wendy's")
    expect(findDeal('bk-nuggets-20')?.merchant).toBe('Burger King')
  })

  it('reports which deals are offered', () => {
    expect(isDealOffered('mcd-nuggets-20')).toBe(true)
    expect(isDealOffered('wendys-nuggets-20')).toBe(false)
    expect(isDealOffered('bk-nuggets-20')).toBe(false)
    expect(isDealOffered('no-such-deal')).toBe(false)
  })

  it('names only deals that exist, so a typo cannot silently gate nothing', () => {
    for (const id of INACTIVE_DEAL_IDS) {
      expect(findDeal(id), `INACTIVE_DEAL_IDS names unknown deal ${id}`).toBeDefined()
    }
  })

  it('never gates every deal — the app must always offer something', () => {
    expect(ACTIVE_DEALS.length).toBeGreaterThan(0)
  })
})

describe('mobile ordering links (#148)', () => {
  it('points the offered deal at the merchant, never an aggregator', () => {
    for (const deal of ACTIVE_DEALS) {
      expect(deal.mobileOrderUrl).not.toBeNull()
      // A per-merchant URL, not a literal repeated at a call site — proven by
      // deriving the expected host from the deal's own data rather than typing
      // "mcdonalds.com" a second time here.
      const host = new URL(deal.mobileOrderUrl as string).hostname
      expect(host.endsWith(merchantDomain(deal.merchant))).toBe(true)
      for (const banned of ['doordash.com', 'ubereats.com', 'grubhub.com']) {
        expect(host.endsWith(banned)).toBe(false)
      }
    }
  })

  it('leaves an unconfirmed link as null rather than a guessed URL', () => {
    // A chain that is not offered has no orderer to send anywhere; the field
    // stays null until the chain is re-offered with a real link.
    for (const id of INACTIVE_DEAL_IDS) {
      expect(findDeal(id)?.mobileOrderUrl).toBeNull()
    }
  })
})

/** The registrable domain a merchant's own site would answer on — test-only. */
function merchantDomain(merchant: string): string {
  const known: Record<string, string> = { "McDonald's": 'mcdonalds.com' }
  const domain = known[merchant]
  if (domain === undefined) throw new Error(`no known domain fixture for ${merchant}`)
  return domain
}

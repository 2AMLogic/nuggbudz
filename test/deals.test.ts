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

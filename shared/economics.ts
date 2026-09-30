/**
 * Settlement math for a bulk split.
 *
 * Every amount in this module is an integer number of cents. Floating point
 * money is how you end up with a party of three each paying $2.9966666.
 */

export interface LineItem {
  /** Human label, e.g. '20pc Chicken McNuggets' */
  item: string
  /** Units of protein in the item — nuggets, tenders, wings. */
  pieces: number
  priceCents: number
}

export interface DealSpec {
  id: string
  merchant: string
  /** Short marketing label for the deal card. */
  label: string
  /** The bulk item the party actually buys and divides. */
  bulk: LineItem
  /** What one person would have bought alone. This is the savings baseline. */
  solo: LineItem
  /** NuggBudz take, added on top of the box price and split with it. */
  platformFeeCents: number
  /** How many buyers this deal is designed to split across. */
  partySize: number
  /**
   * Where the orderer places the actual order, once matched — this merchant's
   * mobile ordering page, never an aggregator (DoorDash/Uber Eats markup erases
   * the spread this deal exists to arbitrage). `null` when the chain is not
   * offered yet (see `INACTIVE_DEAL_IDS`) and no link has been confirmed for it.
   * Per-merchant so re-offering a chain never means finding a hardcoded URL at a
   * call site — see #148.
   */
  mobileOrderUrl: string | null
}

export type BuyerRole = 'orderer' | 'receiver'

export interface BuyerShare {
  role: BuyerRole
  /** What this buyer is charged, in cents. */
  payCents: number
  /** What this buyer would have paid buying solo. */
  soloBaselineCents: number
  /** soloBaselineCents - payCents. Positive means they came out ahead. */
  savingsCents: number
  /** Savings as a whole-number percentage of the solo baseline. */
  savingsPct: number
  piecesOwed: number
}

export interface Settlement {
  dealId: string
  partySize: number
  /** Sum of every buyer's payCents. */
  totalCollectedCents: number
  /** What the party pays the merchant for the bulk item. */
  cogsCents: number
  platformFeeCents: number
  shares: BuyerShare[]
}

export interface SpreadAnalysis {
  /** partySize buyers each buying the solo item instead. */
  soloTotalCents: number
  bulkPriceCents: number
  /** How much retail value the bulk box unlocks versus everyone going solo. */
  grossSpreadCents: number
  /** grossSpreadCents as a percentage of soloTotalCents. */
  grossMarginPct: number
}

export class DealConfigError extends Error {}

/**
 * Split `total` into `parts` integer amounts that sum exactly to `total`.
 *
 * Indivisible remainders go to the earliest indices. In a settlement the
 * orderer sits at index 0, so the person who physically places the order
 * absorbs any stray cent — they are the one holding the box, and a buyer
 * being charged a cent less than their buddy never generates a support
 * ticket, whereas a cent more does.
 */
export function divideCents(total: number, parts: number): number[] {
  if (!Number.isInteger(total))
    throw new DealConfigError('total must be an integer number of cents')
  if (!Number.isInteger(parts) || parts < 1) throw new DealConfigError('parts must be >= 1')
  const base = Math.floor(total / parts)
  const remainder = total - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0))
}

function assertDeal(deal: DealSpec, partySize: number): void {
  if (!Number.isInteger(partySize) || partySize < 2) {
    throw new DealConfigError(
      'partySize must be an integer >= 2; a split needs at least two buyers',
    )
  }
  if (deal.bulk.pieces < partySize) {
    throw new DealConfigError(
      `deal ${deal.id}: ${deal.bulk.pieces} pieces cannot be split across ${partySize} buyers`,
    )
  }
  if (deal.bulk.priceCents < 0 || deal.solo.priceCents < 0 || deal.platformFeeCents < 0) {
    throw new DealConfigError(`deal ${deal.id}: prices and fees must be non-negative`)
  }
}

/**
 * Compute who pays what for a split of `deal` across `partySize` buyers.
 *
 * Invariant: `shares` sum to `cogsCents + platformFeeCents` exactly.
 */
export function settle(deal: DealSpec, partySize: number = deal.partySize): Settlement {
  assertDeal(deal, partySize)

  const totalCollectedCents = deal.bulk.priceCents + deal.platformFeeCents
  const payouts = divideCents(totalCollectedCents, partySize)
  const pieces = divideCents(deal.bulk.pieces, partySize)
  const soloBaselineCents = deal.solo.priceCents

  const shares: BuyerShare[] = payouts.map((payCents, i) => {
    const savingsCents = soloBaselineCents - payCents
    return {
      role: i === 0 ? 'orderer' : 'receiver',
      payCents,
      soloBaselineCents,
      savingsCents,
      savingsPct:
        soloBaselineCents === 0 ? 0 : Math.round((savingsCents / soloBaselineCents) * 100),
      piecesOwed: pieces[i],
    }
  })

  return {
    dealId: deal.id,
    partySize,
    totalCollectedCents,
    cogsCents: deal.bulk.priceCents,
    platformFeeCents: deal.platformFeeCents,
    shares,
  }
}

/** How much retail value the bulk box unlocks versus everyone buying solo. */
export function analyzeSpread(deal: DealSpec, partySize: number = deal.partySize): SpreadAnalysis {
  assertDeal(deal, partySize)
  const soloTotalCents = deal.solo.priceCents * partySize
  const grossSpreadCents = soloTotalCents - deal.bulk.priceCents
  return {
    soloTotalCents,
    bulkPriceCents: deal.bulk.priceCents,
    grossSpreadCents,
    grossMarginPct:
      soloTotalCents === 0 ? 0 : Math.round((grossSpreadCents / soloTotalCents) * 100),
  }
}

/** Render integer cents as a display string, e.g. 449 -> '$4.49'. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

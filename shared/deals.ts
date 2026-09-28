import type { DealSpec } from './economics'

/**
 * The deal catalogue.
 *
 * Prices are the retail spread NuggBudz arbitrages, so they belong in data,
 * never inlined at a call site — they change per market and per promo. A real
 * deployment reads these from D1 per metro; the hackathon build ships the
 * benchmark set.
 */
export const DEALS: readonly DealSpec[] = [
  {
    id: 'mcd-nuggets-20',
    merchant: "McDonald's",
    label: '20pc Chicken McNuggets',
    bulk: { item: '20pc Chicken McNuggets', pieces: 20, priceCents: 799 },
    solo: { item: '10pc Chicken McNuggets', pieces: 10, priceCents: 699 },
    platformFeeCents: 99,
    partySize: 2,
  },
  // Not offered in the app today — see INACTIVE_DEAL_IDS below. Kept as data
  // because the spread being present at three chains is the evidence that it is
  // structural to how the category prices protein, not one chain's promo. The
  // pitch deck derives its figures from these entries, and deleting them would
  // delete that argument.
  {
    id: 'wendys-nuggets-20',
    merchant: "Wendy's",
    label: '20pc Crispy Chicken Nuggets',
    bulk: { item: '20pc Crispy Chicken Nuggets', pieces: 20, priceCents: 849 },
    solo: { item: '10pc Crispy Chicken Nuggets', pieces: 10, priceCents: 729 },
    platformFeeCents: 99,
    partySize: 2,
  },
  {
    id: 'bk-nuggets-20',
    merchant: 'Burger King',
    label: '20pc Chicken Nuggets',
    bulk: { item: '20pc Chicken Nuggets', pieces: 20, priceCents: 599 },
    solo: { item: '8pc Chicken Nuggets', pieces: 8, priceCents: 449 },
    platformFeeCents: 99,
    partySize: 2,
  },
]

/**
 * Deals the app does not currently offer.
 *
 * The hackathon build is focused on McDonald's (operator decision, 2026-09-27),
 * so only that entry is offered to buyers. **To offer a chain again, delete its
 * id from this set — that is the whole change.**
 *
 * This gates what is *offered*, not what exists: `DEALS` stays whole, so the
 * catalogue still evidences the cross-chain spread, `findDeal` still resolves a
 * deal by id, and the pitch deck's figures still derive from real data.
 */
export const INACTIVE_DEAL_IDS: ReadonlySet<string> = new Set([
  'wendys-nuggets-20',
  'bk-nuggets-20',
])

/** The deals a buyer may actually choose from. */
export const ACTIVE_DEALS: readonly DealSpec[] = DEALS.filter(
  (deal) => !INACTIVE_DEAL_IDS.has(deal.id),
)

export function findDeal(dealId: string): DealSpec | undefined {
  return DEALS.find((d) => d.id === dealId)
}

/** True when this deal is offered to buyers right now. */
export function isDealOffered(dealId: string): boolean {
  return !INACTIVE_DEAL_IDS.has(dealId) && findDeal(dealId) !== undefined
}

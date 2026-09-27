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

export function findDeal(dealId: string): DealSpec | undefined {
  return DEALS.find((d) => d.id === dealId)
}

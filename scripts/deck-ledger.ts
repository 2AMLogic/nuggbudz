/**
 * The pitch deck's number ledger.
 *
 * Every money figure, percentage and ratio printed on a slide in `docs/pitch/`
 * is derived here from `shared/deals.ts` and `shared/economics.ts` — the same
 * catalogue and the same `settle` / `analyzeSpread` the Worker charges buyers
 * with. Nothing on a slide is retyped by hand.
 *
 * The paired test (`test/deck.test.ts`, so `pnpm test`) fails in both
 * directions:
 *
 * - **Stale figure** — a slide carries a money/percent/ratio literal this
 *   ledger does not produce (someone repriced a deal and the deck kept the old
 *   number).
 * - **Missing figure** — a literal marked `onSlide` is absent from the deck
 *   (the code moved and the slide never caught up).
 *
 * Kept free of `node:` imports so it stays importable from anywhere: reading
 * files is the caller's job.
 */

import { DEALS } from '../shared/deals'
import type { DealSpec, LineItem } from '../shared/economics'
import { analyzeSpread, formatCents, settle } from '../shared/economics'

export interface DeckFact {
  /** Stable dotted key, e.g. `mcd-nuggets-20.each.pay`. */
  key: string
  /** The exact string a slide must spell, e.g. `$4.49`. */
  literal: string
  /** Derivation, quoted verbatim in failure output so a drift is self-explaining. */
  source: string
  /**
   * True when the deck is expected to carry this literal. A missing `onSlide`
   * literal fails the test; a ledger entry that is merely `allowed` may appear
   * without being required (alternative framings of the same deal).
   */
  onSlide: boolean
}

/**
 * Pairing volumes the take-rate slide walks.
 *
 * The slide is arithmetic on the fee, not a forecast — see the speaker notes.
 */
export const VOLUME_ROWS: readonly number[] = [10, 25, 100]

/**
 * Money and percentage literals a slide may carry that are *not* deal
 * economics. Every entry needs a reason, and an empty map is the goal: an
 * exception here is a number no test can defend.
 */
export const NON_DERIVED_LITERALS: Readonly<Record<string, string>> = {}

/** Cost per piece, rounded to the cent, e.g. 799/20 -> 40 -> `$0.40`. */
function perPieceCents(item: LineItem): number {
  return Math.round(item.priceCents / item.pieces)
}

/** Exact cost per piece, unrounded, e.g. 799/20 -> 39.95. Used by the chart data. */
function exactPerPiece(item: LineItem): number {
  return item.priceCents / item.pieces
}

function pct(whole: number): string {
  return `${whole}%`
}

/** What the whole party saves against buying solo, in cents. */
function partySavings(deal: DealSpec): number {
  return settle(deal).shares.reduce((sum, share) => sum + share.savingsCents, 0)
}

/** Facts for one deal in the catalogue. */
function dealFacts(deal: DealSpec, hero: boolean): DeckFact[] {
  const settlement = settle(deal)
  const spread = analyzeSpread(deal)
  const share = settlement.shares[0]
  const buddy = settlement.shares[1]
  const at = `shared/deals.ts:${deal.id}`
  const f = (key: string, literal: string, source: string, onSlide: boolean = hero): DeckFact => ({
    key: `${deal.id}.${key}`,
    literal,
    source,
    onSlide,
  })

  const facts: DeckFact[] = [
    f('merchant', deal.merchant, `${at} merchant`, true),
    f('bulk.price', formatCents(deal.bulk.priceCents), `${at} bulk.priceCents`, true),
    f('solo.price', formatCents(deal.solo.priceCents), `${at} solo.priceCents`, true),
    f(
      'solo.total',
      formatCents(spread.soloTotalCents),
      `analyzeSpread(${deal.id}).soloTotalCents — ${deal.partySize} solo boxes`,
    ),
    f('fee', formatCents(deal.platformFeeCents), `${at} platformFeeCents`),
    f(
      'collected',
      formatCents(settlement.totalCollectedCents),
      `settle(${deal.id}).totalCollectedCents — box + fee`,
    ),
    f('each.pay', formatCents(share.payCents), `settle(${deal.id}).shares[0].payCents`, true),
    f(
      'each.save',
      formatCents(share.savingsCents),
      `settle(${deal.id}).shares[0].savingsCents`,
      true,
    ),
    f('each.save.pct', pct(share.savingsPct), `settle(${deal.id}).shares[0].savingsPct`),
    f(
      'spread',
      formatCents(spread.grossSpreadCents),
      `analyzeSpread(${deal.id}).grossSpreadCents`,
      true,
    ),
    f('spread.pct', pct(spread.grossMarginPct), `analyzeSpread(${deal.id}).grossMarginPct`),
    f(
      'take.pct',
      pct(Math.round((deal.platformFeeCents / settlement.totalCollectedCents) * 100)),
      `${at} platformFeeCents / settle(${deal.id}).totalCollectedCents`,
    ),
    f(
      'per.piece.bulk',
      formatCents(perPieceCents(deal.bulk)),
      `${at} bulk.priceCents / bulk.pieces, to the cent`,
    ),
    f(
      'per.piece.solo',
      formatCents(perPieceCents(deal.solo)),
      `${at} solo.priceCents / solo.pieces, to the cent`,
    ),
    f(
      'per.piece.ratio',
      `${(exactPerPiece(deal.solo) / exactPerPiece(deal.bulk)).toFixed(2)}×`,
      `${at} solo cost per piece / bulk cost per piece`,
    ),
    f(
      'party.savings',
      formatCents(partySavings(deal)),
      `settle(${deal.id}) — savingsCents summed across the party`,
    ),
    f(
      'solo.vs.bulk.pct',
      pct(Math.round((deal.solo.priceCents / deal.bulk.priceCents) * 100)),
      `${at} solo.priceCents / bulk.priceCents — the inversion, as a share of the bigger box`,
    ),
    f(
      'spread.to.buyers.pct',
      pct(Math.round((partySavings(deal) / spread.grossSpreadCents) * 100)),
      `settle(${deal.id}) party savings / analyzeSpread(${deal.id}).grossSpreadCents`,
    ),
    f(
      'spread.to.platform.pct',
      pct(Math.round((deal.platformFeeCents / spread.grossSpreadCents) * 100)),
      `${at} platformFeeCents / analyzeSpread(${deal.id}).grossSpreadCents`,
    ),
  ]

  // Only worth spelling out when the split is not even; it is documentation of
  // `divideCents` giving the odd cent to the orderer.
  if (buddy.payCents !== share.payCents) {
    facts.push(
      f('buddy.pay', formatCents(buddy.payCents), `settle(${deal.id}).shares[1].payCents`, false),
    )
  }
  return facts
}

/** Take-rate arithmetic: the same fee at several pairing volumes. */
function volumeFacts(deal: DealSpec): DeckFact[] {
  const perPairing = partySavings(deal)
  return VOLUME_ROWS.flatMap((pairings) => [
    {
      key: `volume.${pairings}.take`,
      literal: formatCents(deal.platformFeeCents * pairings),
      source: `shared/deals.ts:${deal.id} platformFeeCents x ${pairings} pairings`,
      onSlide: true,
    },
    {
      key: `volume.${pairings}.savings`,
      literal: formatCents(perPairing * pairings),
      source: `settle(${deal.id}) party savings x ${pairings} pairings`,
      onSlide: true,
    },
  ])
}

/**
 * The full ledger: one entry per figure the deck is allowed to print.
 *
 * `DEALS[0]` is the hero deal the story is told through; the rest carry only
 * the literals the catalogue slide tabulates.
 */
export function buildLedger(deals: readonly DealSpec[] = DEALS): DeckFact[] {
  const hero = deals[0]
  return [...deals.flatMap((deal) => dealFacts(deal, deal.id === hero.id)), ...volumeFacts(hero)]
}

/** How many assertions `scripts/smoke.mjs` makes, counted from its source. */
export function countSmokeChecks(smokeSource: string): number {
  return (smokeSource.match(/^\s*check\(|[^a-z]check\(/gm) ?? []).length
}

/**
 * The end-to-end check count, as the deck spells it (`22/22`).
 *
 * On the shipped-status slide, so adding a smoke assertion without touching the
 * deck fails the same way a repriced deal does.
 */
export function smokeFact(smokeSource: string): DeckFact {
  const count = countSmokeChecks(smokeSource)
  return {
    key: 'smoke.checks',
    literal: `${count}/${count}`,
    source: `scripts/smoke.mjs — ${count} check() assertions`,
    onSlide: true,
  }
}

/** Money, percentage and ratio shapes that must trace back to the ledger. */
const SCANNERS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'money', pattern: /\$\d[\d,]*(?:\.\d{1,2})?/g },
  { kind: 'percent', pattern: /\b\d{1,3}(?:\.\d+)?%/g },
  { kind: 'ratio', pattern: /\b\d+(?:\.\d+)?×/g },
]

export interface DeckFile {
  /** Display name used in failure output, e.g. `deck.md`. */
  name: string
  text: string
}

export interface Orphan {
  file: string
  kind: string
  literal: string
}

export interface DriftReport {
  /** Ledger entries marked `onSlide` that no slide spells. */
  missing: DeckFact[]
  /** Literals on a slide that the ledger does not produce. */
  orphans: Orphan[]
}

/**
 * Compare deck prose against the ledger.
 *
 * `slides` is scanned for orphans *and* checked for coverage; `supporting`
 * (speaker notes, critic siblings) is scanned for orphans only — notes may
 * legitimately omit a figure, but must never contradict one.
 */
export function auditDeck(
  slides: DeckFile,
  supporting: readonly DeckFile[] = [],
  ledger: readonly DeckFact[] = buildLedger(),
): DriftReport {
  const allowed = new Set<string>([
    ...ledger.map((fact) => fact.literal),
    ...Object.keys(NON_DERIVED_LITERALS),
  ])

  const orphans: Orphan[] = []
  for (const file of [slides, ...supporting]) {
    for (const { kind, pattern } of SCANNERS) {
      for (const hit of file.text.match(pattern) ?? []) {
        if (!allowed.has(hit)) orphans.push({ file: file.name, kind, literal: hit })
      }
    }
  }

  return {
    missing: ledger.filter((fact) => fact.onSlide && !slides.text.includes(fact.literal)),
    orphans,
  }
}

/**
 * Chart data for the per-nugget figure, generated rather than transcribed.
 *
 * `test/deck.test.ts` asserts the committed CSV equals this byte for byte, so
 * the bar chart cannot outlive a price change either.
 */
export function renderPerPieceCsv(deals: readonly DealSpec[] = DEALS): string {
  const rows = deals.flatMap((deal) => [
    { deal, basket: 'bulk', item: deal.bulk },
    { deal, basket: 'solo', item: deal.solo },
  ])
  const lines = [
    'deal_id,merchant,basket,label,pieces,price_cents,cents_per_piece',
    ...rows.map(({ deal, basket, item }) =>
      [
        deal.id,
        `"${deal.merchant}"`,
        basket,
        `"${item.item}"`,
        String(item.pieces),
        String(item.priceCents),
        exactPerPiece(item).toFixed(2),
      ].join(','),
    ),
  ]
  return `${lines.join('\n')}\n`
}

/** One `key = literal  # source` line per fact, for eyeballing the ledger. */
export function formatLedger(ledger: readonly DeckFact[] = buildLedger()): string {
  const keyWidth = Math.max(...ledger.map((fact) => fact.key.length))
  const litWidth = Math.max(...ledger.map((fact) => fact.literal.length))
  return ledger
    .map((fact) =>
      [
        fact.key.padEnd(keyWidth),
        fact.literal.padEnd(litWidth),
        fact.onSlide ? 'slide' : '     ',
        fact.source,
      ].join('  '),
    )
    .join('\n')
}

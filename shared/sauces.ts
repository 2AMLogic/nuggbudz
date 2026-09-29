/**
 * The sauce catalogue, and the horoscope derived from a pair of them.
 *
 * Sauces are data for the same reason deal prices are (`shared/deals.ts`): they
 * belong to a merchant, they change with a promo, and a literal `'Hot Mustard'`
 * at a call site is a string that has to be found again the day the menu moves.
 * Which sauces are *offered* follows which deals are offered — a chain gated out
 * of `ACTIVE_DEALS` takes its sauces with it, and bringing the chain back brings
 * them back, with no second list to keep in step.
 *
 * The readout is a pure function of the pair. Not `Math.random()`, not seeded
 * from the clock, not fetched: a buyer who reloads and reads something different
 * has learned the feature is noise. It is also the only way a test can pin it.
 *
 * It is *composed* rather than written out per pair. Eight sauces are 36
 * selections once a double counts, so bespoke lines would rot the moment a sauce
 * was added — and adding one here is one data entry, whose lines the
 * exhaustiveness test in `test/sauces.test.ts` then insists exist.
 */
import { ACTIVE_DEALS, DEALS } from './deals'

/** How much heat or sweetness a sauce brings, on a four-point scale. */
export type SauceIntensity = 0 | 1 | 2 | 3

export interface SauceSpec {
  id: string
  /** The chain that pours it. A sauce is a merchant's, never the platform's. */
  merchant: string
  /** What it is called on the menu, and therefore at the counter. */
  label: string
  /** Feeds the horoscope's heat axis. Never shown to a buyer as a number. */
  heat: SauceIntensity
  /** Feeds the sweetness axis. Same. */
  sweet: SauceIntensity
  /**
   * What ordering it says about you, as a lowercase noun phrase that reads in a
   * list — `${trait} and ${trait}` — in either position, because the pair is
   * unordered and every sauce turns up on both sides of that "and".
   */
  trait: string
}

/**
 * Every sauce the catalogue knows, offered or not.
 *
 * Kept whole for the reason `DEALS` is: the gated chains are evidence the
 * category behaves this way generally, and a catalogue that only ever held what
 * is currently on sale could not show that.
 */
export const SAUCES: readonly SauceSpec[] = [
  {
    id: 'mcd-tangy-bbq',
    merchant: "McDonald's",
    label: 'Tangy BBQ',
    heat: 1,
    sweet: 2,
    trait: 'a safe pair of hands',
  },
  {
    id: 'mcd-spicy-buffalo',
    merchant: "McDonald's",
    label: 'Spicy Buffalo',
    heat: 3,
    sweet: 0,
    trait: 'a well-kept grudge',
  },
  {
    id: 'mcd-honey-mustard',
    merchant: "McDonald's",
    label: 'Honey Mustard',
    heat: 1,
    sweet: 2,
    trait: 'diplomacy',
  },
  {
    id: 'mcd-creamy-ranch',
    merchant: "McDonald's",
    label: 'Creamy Ranch',
    heat: 0,
    sweet: 1,
    trait: 'a standing alibi',
  },
  {
    id: 'mcd-sweet-n-sour',
    merchant: "McDonald's",
    label: "Sweet 'N Sour",
    heat: 0,
    sweet: 3,
    trait: 'nostalgia',
  },
  {
    id: 'mcd-hot-mustard',
    merchant: "McDonald's",
    label: 'Hot Mustard',
    heat: 2,
    sweet: 1,
    trait: 'brinkmanship',
  },
  {
    id: 'mcd-sweet-chili',
    merchant: "McDonald's",
    label: 'Sweet Chili',
    heat: 2,
    sweet: 3,
    trait: 'a taste for the dramatic',
  },
  {
    id: 'mcd-ketchup',
    merchant: "McDonald's",
    label: 'Ketchup',
    heat: 0,
    sweet: 2,
    trait: 'no notes',
  },
  // Gated out with their chains — see `isSauceOffered`. Data, not an offer.
  {
    id: 'wendys-s-awesome',
    merchant: "Wendy's",
    label: "S'Awesome",
    heat: 1,
    sweet: 2,
    trait: 'borrowed confidence',
  },
  {
    id: 'wendys-ghost-pepper-ranch',
    merchant: "Wendy's",
    label: 'Ghost Pepper Ranch',
    heat: 3,
    sweet: 1,
    trait: 'a high pain threshold',
  },
  {
    id: 'bk-zesty',
    merchant: 'Burger King',
    label: 'Zesty Sauce',
    heat: 2,
    sweet: 1,
    trait: 'an opinion about horseradish',
  },
  {
    id: 'bk-sweet-bbq',
    merchant: 'Burger King',
    label: 'Sweet BBQ',
    heat: 1,
    sweet: 2,
    trait: 'a short memory',
  },
]

/**
 * The chains whose deals a buyer may actually choose right now.
 *
 * Derived, so the sauce menu cannot drift from the deal menu: gating a chain in
 * `shared/deals.ts` gates its sauces in the same edit, and there is no second
 * list for a future operator to forget.
 */
const OFFERED_MERCHANTS: ReadonlySet<string> = new Set(ACTIVE_DEALS.map((deal) => deal.merchant))

/** The sauces a buyer may actually pick from today. */
export const ACTIVE_SAUCES: readonly SauceSpec[] = SAUCES.filter((sauce) =>
  OFFERED_MERCHANTS.has(sauce.merchant),
)

export function findSauce(sauceId: string): SauceSpec | undefined {
  return SAUCES.find((sauce) => sauce.id === sauceId)
}

/** True when this sauce is on a menu the app currently pairs buyers on. */
export function isSauceOffered(sauceId: string): boolean {
  const sauce = findSauce(sauceId)
  return sauce !== undefined && OFFERED_MERCHANTS.has(sauce.merchant)
}

/** Every sauce this chain pours, in catalogue order. */
export function saucesForMerchant(merchant: string): readonly SauceSpec[] {
  return SAUCES.filter((sauce) => sauce.merchant === merchant)
}

/**
 * A buyer's pick: two sauce ids.
 *
 * **Two, unordered, and a double is allowed.** Unordered because a pair of tubs
 * on a tray has no first and second, and a double because "two Hot Mustards" is
 * a real order somebody wants placed. Ordered pairs would have doubled the
 * selection space to say nothing a buyer means, so the ids here are always in
 * catalogue order — `parseSauceSelection` puts them there — which makes equality,
 * storage and the readout all agree on one spelling per choice.
 */
export type SauceSelection = readonly [string, string]

/** How many sauces a selection is. Two: see `SauceSelection`. */
export const SAUCES_PER_SELECTION = 2

/** Longest id the catalogue could plausibly hold, as a cheap bound on parsing. */
const MAX_SAUCE_ID_LENGTH = 64

function catalogueIndex(sauceId: string): number {
  return SAUCES.findIndex((sauce) => sauce.id === sauceId)
}

/**
 * Narrow an untrusted pair of sauce ids to a selection, or reject it.
 *
 * Everything that reaches here is hostile by default — a WebSocket frame, a JSON
 * body, a row written before the menu changed, a `localStorage` value some other
 * script could have set. So this answers "may this be chosen", not "is this a
 * string": an id that is not on an offered menu is refused rather than stored,
 * and the caller has a validated value to echo instead of the caller's own.
 *
 * `merchant`, when given, additionally insists both sauces come from that chain,
 * which is what stops a hand-rolled `join` frame from ordering a Wendy's sauce
 * with a McDonald's box.
 */
export function parseSauceSelection(raw: unknown, merchant?: string): SauceSelection | null {
  if (!Array.isArray(raw) || raw.length !== SAUCES_PER_SELECTION) return null

  const ids: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    if (entry.length === 0 || entry.length > MAX_SAUCE_ID_LENGTH) return null
    const sauce = findSauce(entry)
    if (sauce === undefined) return null
    if (!OFFERED_MERCHANTS.has(sauce.merchant)) return null
    if (merchant !== undefined && sauce.merchant !== merchant) return null
    ids.push(sauce.id)
  }

  // Canonical order, so one choice has one spelling wherever it is compared or
  // stored. A double is left as it is — both ids are already equal.
  ids.sort((a, b) => catalogueIndex(a) - catalogueIndex(b))
  return [ids[0], ids[1]]
}

/**
 * Apply one tap to the taps already made: the picker's whole state rule.
 *
 * A sliding window of the last two taps, oldest evicted first. A buyer holding a
 * finished pair who taps a third sauce means "that one instead of the one I
 * picked first", not "throw both away and start again" — the earlier rule
 * cleared the pair, so correcting the second half of a pair cost you the half
 * you were happy with, and tapping one sauce three times alternated between a
 * double and a single for no reason a buyer could see.
 *
 * Kept here rather than in the hook because it is the selection rule, not a
 * React detail, and because `test/sauces.test.ts` can drive a tap sequence
 * without a DOM. Taps are *not* canonicalised — they are what the buyer pressed,
 * in that order, which is what eviction is defined against; `parseSauceSelection`
 * is still the only thing that turns two of them into a stored selection.
 */
export function tapSauce(picks: readonly string[], sauceId: string): readonly string[] {
  return [...picks, sauceId].slice(-SAUCES_PER_SELECTION)
}

/**
 * Resolve a selection's ids to their catalogue entries, in canonical order.
 *
 * Null when either id is unknown, which is how a caller holding a selection from
 * outside (a stored preference, a buddy's pick off the wire) says "show nothing"
 * rather than rendering a blank.
 */
export function resolveSauceSelection(
  selection: readonly string[] | null | undefined,
): readonly [SauceSpec, SauceSpec] | null {
  if (selection === null || selection === undefined) return null
  if (selection.length !== SAUCES_PER_SELECTION) return null
  const first = findSauce(selection[0])
  const second = findSauce(selection[1])
  if (first === undefined || second === undefined) return null
  return catalogueIndex(first.id) <= catalogueIndex(second.id) ? [first, second] : [second, first]
}

/** The pair as the person at the counter has to ask for it. */
export function describeSauceOrder(first: SauceSpec, second: SauceSpec): string {
  if (first.id === second.id) return `2x ${first.label}`
  return `${first.label} + ${second.label}`
}

/** The same thing from ids, or null when they do not resolve. */
export function describeSauceSelection(
  selection: readonly string[] | null | undefined,
): string | null {
  const pair = resolveSauceSelection(selection)
  return pair === null ? null : describeSauceOrder(pair[0], pair[1])
}

export type HeatBand = 'mild' | 'warm' | 'hot'
export type SweetBand = 'dry' | 'balanced' | 'sweet'

/**
 * The two axes the second line is read off, banded from the pair's totals.
 *
 * Bands rather than raw totals so the table below is nine lines whatever the
 * catalogue does: a new sauce moves a pair between bands, it never demands a new
 * string. Both functions are total over the 0..6 a pair of `SauceIntensity`
 * values can sum to, which is what makes the readout total too.
 */
export function heatBand(total: number): HeatBand {
  if (total <= 1) return 'mild'
  if (total <= 3) return 'warm'
  return 'hot'
}

export function sweetBand(total: number): SweetBand {
  if (total <= 1) return 'dry'
  if (total <= 3) return 'balanced'
  return 'sweet'
}

/**
 * The chart's verdict for each corner of the two axes.
 *
 * Typed as a total record, so adding a *band* is a compile error until its lines
 * are written, while adding a sauce is not — which is the right way round.
 */
const VERDICTS: Readonly<Record<HeatBand, Readonly<Record<SweetBand, string>>>> = {
  mild: {
    dry: 'A chart with nothing to declare. You will arrive early and wait anyway.',
    balanced: 'Steady hands, soft landing. The box arrives intact.',
    sweet: 'Sweet and harmless, like most good decisions. Someone will ask for one.',
  },
  warm: {
    dry: 'Heat without a cushion. You will be the one who counts the nuggets.',
    balanced: 'The house average, and the house is usually right. Split it, say little.',
    sweet: 'You are negotiating with yourself and winning. Order the twenty.',
  },
  hot: {
    dry: 'All edge, no comfort. Drink something before you speak.',
    balanced: 'Fire with a chaperone. You will finish first and deny it.',
    sweet: 'Scorched and candied. Mercury is in the fryer; proceed regardless.',
  },
}

/** Sentence-case a lowercase trait without touching the rest of it. */
function opening(trait: string): string {
  return trait.charAt(0).toUpperCase() + trait.slice(1)
}

export interface Horoscope {
  /** Two lines, in reading order. Neither is ever empty. */
  lines: readonly [string, string]
  /** What to actually ask for at the counter, e.g. `2x Ketchup`. */
  counterOrder: string
}

/**
 * Read the pair.
 *
 * Total by construction: both lines are composed from fields every `SauceSpec`
 * carries, so there is no pair of catalogue entries this can fail to answer for
 * and no blank card to ship. Symmetric in its arguments, because the selection is
 * unordered — `(a, b)` and `(b, a)` are the same choice and must read the same.
 */
export function readSauceHoroscope(first: SauceSpec, second: SauceSpec): Horoscope {
  const [a, b] =
    catalogueIndex(first.id) <= catalogueIndex(second.id) ? [first, second] : [second, first]

  const traits =
    a.id === b.id ? `${opening(a.trait)}, twice.` : `${opening(a.trait)} and ${b.trait}.`
  const verdict = VERDICTS[heatBand(a.heat + b.heat)][sweetBand(a.sweet + b.sweet)]

  return { lines: [traits, verdict], counterOrder: describeSauceOrder(a, b) }
}

/** The reading for a selection of ids, or null when they do not resolve. */
export function horoscopeForSelection(
  selection: readonly string[] | null | undefined,
): Horoscope | null {
  const pair = resolveSauceSelection(selection)
  return pair === null ? null : readSauceHoroscope(pair[0], pair[1])
}

/**
 * Every selection reachable from a catalogue: each unordered pair, plus every
 * double.
 *
 * This exists so the exhaustiveness test enumerates the selection space from the
 * catalogue rather than from a hand-written list of cases. A hand-written list
 * would keep passing the day a sauce is added and a card goes blank; this makes
 * that the failure it should be.
 */
export function allSauceSelections(
  sauces: readonly SauceSpec[],
): readonly [SauceSpec, SauceSpec][] {
  const out: [SauceSpec, SauceSpec][] = []
  for (let i = 0; i < sauces.length; i++) {
    for (let j = i; j < sauces.length; j++) {
      out.push([sauces[i], sauces[j]])
    }
  }
  return out
}

/** Merchants named in the deal catalogue — what a sauce's `merchant` must match. */
export const CATALOGUE_MERCHANTS: ReadonlySet<string> = new Set(DEALS.map((deal) => deal.merchant))

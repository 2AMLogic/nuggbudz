import { describe, expect, it } from 'vitest'
import { DEALS } from '../shared/deals'
import {
  ACTIVE_SAUCES,
  allSauceSelections,
  CATALOGUE_MERCHANTS,
  describeSauceSelection,
  findSauce,
  heatBand,
  horoscopeForSelection,
  isSauceOffered,
  parseSauceSelection,
  readSauceHoroscope,
  SAUCES,
  SAUCES_PER_SELECTION,
  saucesForMerchant,
  sweetBand,
} from '../shared/sauces'
import sauceSource from '../shared/sauces.ts?raw'

describe('the sauce catalogue', () => {
  it('names a merchant the deal catalogue knows, so a typo cannot hide a sauce', () => {
    for (const sauce of SAUCES) {
      expect(CATALOGUE_MERCHANTS.has(sauce.merchant), `${sauce.id} names ${sauce.merchant}`).toBe(
        true,
      )
    }
    expect(CATALOGUE_MERCHANTS.size).toBe(new Set(DEALS.map((deal) => deal.merchant)).size)
  })

  it('has unique ids', () => {
    expect(new Set(SAUCES.map((sauce) => sauce.id)).size).toBe(SAUCES.length)
  })

  it('carries the traits the readout composes from, for every entry', () => {
    // The horoscope is built out of these three fields, so a sauce missing one is
    // a blank card waiting to happen. Checked here rather than trusted to review.
    for (const sauce of SAUCES) {
      expect(sauce.label.length, sauce.id).toBeGreaterThan(0)
      expect(sauce.trait.length, sauce.id).toBeGreaterThan(0)
      // Lowercase, because the readout sentence-cases the first trait and reads
      // the second mid-sentence. A capitalised trait would shout in one of them.
      expect(sauce.trait[0], sauce.id).toBe(sauce.trait[0].toLowerCase())
      expect([0, 1, 2, 3], `${sauce.id} heat`).toContain(sauce.heat)
      expect([0, 1, 2, 3], `${sauce.id} sweet`).toContain(sauce.sweet)
    }
  })

  it('offers only the sauces of a chain the app pairs on', () => {
    // Derived from ACTIVE_DEALS, so #28's gate covers sauces without a second
    // list to keep in step: McDonald's is the only chain offered today.
    expect(new Set(ACTIVE_SAUCES.map((sauce) => sauce.merchant))).toEqual(new Set(["McDonald's"]))
    expect(ACTIVE_SAUCES.length).toBeGreaterThan(0)
    expect(ACTIVE_SAUCES).toEqual(saucesForMerchant("McDonald's"))
  })

  it('keeps a gated chain’s sauces as data, resolvable by id', () => {
    expect(findSauce('wendys-ghost-pepper-ranch')?.merchant).toBe("Wendy's")
    expect(isSauceOffered('wendys-ghost-pepper-ranch')).toBe(false)
    expect(isSauceOffered('bk-zesty')).toBe(false)
    expect(isSauceOffered('mcd-ketchup')).toBe(true)
    expect(isSauceOffered('mcd-no-such-sauce')).toBe(false)
  })
})

describe('parsing an untrusted selection', () => {
  it('refuses anything that is not two ids from an offered menu', () => {
    expect(parseSauceSelection(undefined)).toBeNull()
    expect(parseSauceSelection(null)).toBeNull()
    expect(parseSauceSelection('mcd-ketchup')).toBeNull()
    expect(parseSauceSelection([])).toBeNull()
    expect(parseSauceSelection(['mcd-ketchup'])).toBeNull()
    expect(parseSauceSelection(['mcd-ketchup', 'mcd-ketchup', 'mcd-ketchup'])).toBeNull()
    expect(parseSauceSelection(['mcd-ketchup', 42])).toBeNull()
    expect(parseSauceSelection(['mcd-ketchup', ''])).toBeNull()
    expect(parseSauceSelection(['mcd-ketchup', 'x'.repeat(200)])).toBeNull()
    expect(parseSauceSelection(['mcd-ketchup', '<script>alert(1)</script>'])).toBeNull()
    // A real sauce of a chain the app does not pair on is the harder case: it
    // resolves in the catalogue and still must not be choosable.
    expect(parseSauceSelection(['mcd-ketchup', 'bk-zesty'])).toBeNull()
  })

  it('accepts two offered ids and puts them in catalogue order', () => {
    const forwards = parseSauceSelection(['mcd-ketchup', 'mcd-tangy-bbq'])
    const backwards = parseSauceSelection(['mcd-tangy-bbq', 'mcd-ketchup'])
    expect(forwards).toEqual(['mcd-tangy-bbq', 'mcd-ketchup'])
    // Unordered: one choice, one spelling, whichever way it arrived.
    expect(backwards).toEqual(forwards)
  })

  it('accepts a double order of one sauce', () => {
    expect(parseSauceSelection(['mcd-hot-mustard', 'mcd-hot-mustard'])).toEqual([
      'mcd-hot-mustard',
      'mcd-hot-mustard',
    ])
  })

  it('can insist both sauces come from one chain’s menu', () => {
    expect(parseSauceSelection(['mcd-ketchup', 'mcd-hot-mustard'], "McDonald's")).toEqual([
      'mcd-hot-mustard',
      'mcd-ketchup',
    ])
    expect(parseSauceSelection(['mcd-ketchup', 'mcd-hot-mustard'], "Wendy's")).toBeNull()
  })
})

describe('the horoscope', () => {
  it('is the same reading for the same pair, every time', () => {
    const ketchup = findSauce('mcd-ketchup')
    const mustard = findSauce('mcd-hot-mustard')
    if (ketchup === undefined || mustard === undefined) throw new Error('fixture sauce missing')

    const first = readSauceHoroscope(ketchup, mustard)
    const second = readSauceHoroscope(ketchup, mustard)
    expect(second).toEqual(first)
    // A third read after other pairs have been read: no accumulated state.
    readSauceHoroscope(mustard, mustard)
    expect(readSauceHoroscope(ketchup, mustard)).toEqual(first)
  })

  it('reads the same whichever way the pair is handed over', () => {
    for (const [a, b] of allSauceSelections(SAUCES)) {
      expect(readSauceHoroscope(b, a), `${a.id} / ${b.id}`).toEqual(readSauceHoroscope(a, b))
    }
  })

  it('derives the reading rather than rolling for it', () => {
    // The determinism above would also pass for a reading seeded once per process.
    // This is the guard against that: nothing the module *executes* may consult a
    // random source, the clock, or the network. Comments are stripped first,
    // because the module's own docs name the things it refuses to do.
    const code = sauceSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/Math\.random|crypto\.getRandomValues|randomUUID/)
    expect(code).not.toMatch(/Date\.now|new Date\(/)
    expect(code).not.toMatch(/\bfetch\(/)
  })

  it('answers for every selection the catalogue can reach', () => {
    // Enumerated from the catalogue, not from a list of cases written by hand:
    // adding a sauce has to fail here loudly rather than ship a blank card.
    const selections = allSauceSelections(SAUCES)
    const n = SAUCES.length
    expect(selections).toHaveLength((n * (n + 1)) / 2)

    for (const [a, b] of selections) {
      const reading = readSauceHoroscope(a, b)
      const where = `${a.id} / ${b.id}`
      expect(reading.lines, where).toHaveLength(2)
      for (const line of reading.lines) {
        expect(typeof line, where).toBe('string')
        expect(line.trim().length, where).toBeGreaterThan(0)
        expect(line, where).not.toMatch(/undefined|NaN|\[object/)
      }
      expect(reading.counterOrder.trim().length, where).toBeGreaterThan(0)
      expect(reading.counterOrder, where).not.toMatch(/undefined/)
    }
  })

  it('answers for every selection a buyer can actually make', () => {
    const offered = allSauceSelections(ACTIVE_SAUCES)
    expect(offered.length).toBeGreaterThan(0)
    for (const [a, b] of offered) {
      const selection = parseSauceSelection([a.id, b.id])
      expect(selection, `${a.id} / ${b.id} must be selectable`).not.toBeNull()
      const reading = horoscopeForSelection(selection)
      expect(reading?.lines[0].length, `${a.id} / ${b.id}`).toBeGreaterThan(0)
      expect(reading?.lines[1].length, `${a.id} / ${b.id}`).toBeGreaterThan(0)
    }
  })

  it('says something different about a different pair', () => {
    // Not a hash of the ids: the reading has to be *about* the sauces, so two
    // pairs that share nothing must not read alike.
    const readings = allSauceSelections(ACTIVE_SAUCES).map(
      ([a, b]) => readSauceHoroscope(a, b).lines[0],
    )
    expect(new Set(readings).size).toBe(readings.length)
  })

  it('says it twice over when a buyer doubles up', () => {
    const ranch = findSauce('mcd-creamy-ranch')
    if (ranch === undefined) throw new Error('fixture sauce missing')
    const double = readSauceHoroscope(ranch, ranch)
    expect(double.counterOrder).toBe('2x Creamy Ranch')
    expect(double.lines[0]).toMatch(/twice/)
  })

  it('bands every total a pair of intensities can reach', () => {
    const maxTotal = 3 * SAUCES_PER_SELECTION
    for (let total = 0; total <= maxTotal; total++) {
      expect(['mild', 'warm', 'hot'], `heat ${total}`).toContain(heatBand(total))
      expect(['dry', 'balanced', 'sweet'], `sweet ${total}`).toContain(sweetBand(total))
    }
  })

  it('names the order the way the counter needs it', () => {
    expect(describeSauceSelection(['mcd-tangy-bbq', 'mcd-ketchup'])).toBe('Tangy BBQ + Ketchup')
    // Canonical order, whichever way the ids arrive.
    expect(describeSauceSelection(['mcd-ketchup', 'mcd-tangy-bbq'])).toBe('Tangy BBQ + Ketchup')
    expect(describeSauceSelection(['mcd-ketchup', 'mcd-ketchup'])).toBe('2x Ketchup')
    expect(describeSauceSelection(null)).toBeNull()
    expect(describeSauceSelection(['mcd-ketchup'])).toBeNull()
    expect(describeSauceSelection(['mcd-ketchup', 'mcd-gone-from-the-menu'])).toBeNull()
    expect(horoscopeForSelection(['mcd-ketchup', 'mcd-gone-from-the-menu'])).toBeNull()
  })
})

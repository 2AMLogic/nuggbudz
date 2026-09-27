import { describe, expect, it } from 'vitest'
import {
  auditDeck,
  buildLedger,
  countSmokeChecks,
  type DeckFile,
  formatLedger,
  renderPerPieceCsv,
  smokeFact,
} from '../scripts/deck-ledger'
import smokeSource from '../scripts/smoke.mjs?raw'

/**
 * Drift guard for the pitch deck in `docs/pitch/`.
 *
 * A deck is where numbers go to die: someone reprices a deal in
 * `shared/deals.ts`, the Worker starts charging the new price, and the slide
 * keeps quoting last month's split. This makes that a red build.
 *
 * Only the newest version directory is checked. Anvil version dirs and critic
 * siblings are immutable by contract, so `nuggbudz-hackathon.1/` is entitled to
 * hold the numbers that were true when it was drafted; the live deck is not.
 */

const markdown = import.meta.glob('../docs/pitch/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const csvs = import.meta.glob('../docs/pitch/**/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** A `<thread>.{N}/` or `<thread>.{N}.<critic>/` path segment. */
const VERSIONED = /\/[^/]+\.\d+(?:\.[a-z][a-z-]*)?\//

/** Highest-numbered `<thread>.{N}/deck.md` — anvil's `.latest`, without the symlink. */
function latestDeck(): { path: string; dir: string; text: string } {
  const ranked = Object.keys(markdown)
    .map((path) => ({ path, n: Number(path.match(/\.(\d+)\/deck\.md$/)?.[1] ?? Number.NaN) }))
    .filter((entry) => Number.isInteger(entry.n))
    .sort((a, b) => b.n - a.n)
  const top = ranked[0]
  if (top === undefined) throw new Error('no versioned deck.md found under docs/pitch/')
  return {
    path: top.path,
    dir: top.path.slice(0, top.path.lastIndexOf('/') + 1),
    text: markdown[top.path],
  }
}

const deck = latestDeck()
const ledger = [...buildLedger(), smokeFact(smokeSource)]

/**
 * Live prose around the deck: the briefs, the refs, and the current version's
 * speaker notes. Superseded version dirs and critic siblings are excluded —
 * they are immutable records of what was true at the time.
 */
const supporting: DeckFile[] = Object.entries(markdown)
  .filter(([path]) => path !== deck.path)
  .filter(([path]) => !VERSIONED.test(path) || path.startsWith(deck.dir))
  .map(([path, text]) => ({ name: path, text }))

describe('pitch deck figures', () => {
  it('quotes no money, percentage or ratio the code does not produce', () => {
    const { orphans } = auditDeck({ name: deck.path, text: deck.text }, supporting, ledger)

    expect(
      orphans.map((o) => `${o.file}: ${o.literal} (${o.kind}) is not in the ledger`),
      'A figure in the pitch does not trace to shared/deals.ts or shared/economics.ts.\n' +
        'Either the code was repriced and the deck is stale, or a slide invented a number.\n' +
        `The ledger:\n${formatLedger(ledger)}\n`,
    ).toEqual([])
  })

  it('carries every figure the code says it should', () => {
    const { missing } = auditDeck({ name: deck.path, text: deck.text }, [], ledger)

    expect(
      missing.map((fact) => `${fact.key} = ${fact.literal} (${fact.source})`),
      'The deck is missing a figure the code produces — reprice the slides, not the ledger.',
    ).toEqual([])
  })

  it('checks the live deck, not a superseded draft', () => {
    expect(supporting.map((file) => file.name)).toContain(`${deck.dir}speaker-notes.md`)
    expect(supporting.some((file) => /\.\d+\.[a-z]/.test(file.name))).toBe(false)
  })

  it('generates the chart data rather than transcribing it', () => {
    const committed = Object.entries(csvs).filter(
      ([path]) => path.startsWith(deck.dir) && path.endsWith('per-nugget.csv'),
    )
    expect(committed.map(([path]) => path)).toHaveLength(1)
    expect(committed[0][1]).toBe(renderPerPieceCsv())
  })

  it('counts the smoke assertions it credits itself with', () => {
    // Not pinned to a literal count here on purpose: the deck is where the
    // number is written down, so adding a smoke assertion fails the deck check
    // rather than this one.
    expect(countSmokeChecks(smokeSource)).toBeGreaterThan(0)
    expect(deck.text).toContain(smokeFact(smokeSource).literal)
  })
})

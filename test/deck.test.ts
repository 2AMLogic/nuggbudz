import { describe, expect, it } from 'vitest'
import {
  auditDeck,
  buildLedger,
  countSmokeChecks,
  type DeckFile,
  formatLedger,
  renderPerPieceCsv,
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
const ledger = buildLedger()

/** `32/32 end-to-end checks` and friends — the shape #46 removed from the deck. */
const PINNED_CHECK_COUNT = /\b\d+(?:\/\d+)?\*{0,2} end-to-end checks?/i

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

  it('claims the smoke suite passes without pinning its size', () => {
    // The deck deliberately does not print a check count: an exact `N/N` on a
    // slide had to be hand-edited by every PR touching scripts/smoke.mjs, and
    // concurrent branches bumping it to the same wrong number merged clean but
    // red (#46). Whether the checks pass is `pnpm smoke`'s job, not the deck's.
    expect(countSmokeChecks(smokeSource)).toBeGreaterThan(0)
    expect(deck.text).toMatch(/every\*{0,2} end-to-end check passes/i)
    expect(deck.text).not.toMatch(PINNED_CHECK_COUNT)
  })

  it('pins no check count in the live prose either', () => {
    // #46 unpinned the slide but left BRIEF.md free to keep its own copy, which
    // it did — stale by more than 4× before anyone noticed (#47), because the
    // orphan scan above only recognises money, percent and ratio shapes. This
    // is the same negative assertion as the deck's, no count attached: the
    // brief is the drafter's contract, so a number here becomes a number on the
    // next revision's slide.
    const pinned = supporting
      .filter((file) => PINNED_CHECK_COUNT.test(file.text))
      .map((file) => file.name)

    expect(
      pinned,
      'Live pitch prose pins an end-to-end check count. The count moves on\n' +
        'nearly every merge, so say the checks pass and name no number —\n' +
        'see "Why the deck does not quote a check count" in refs/smoke-runs.md.\n',
    ).toEqual([])
  })
})

describe('the orphan scan', () => {
  it('ignores a Marp background split width, which is layout and not a claim', () => {
    // `![bg right:34%]` is how a slide asks for a 34%-wide background panel. The
    // viewer never reads it and no catalogue could produce it, so scanning it
    // reports a percentage that cannot be traced and cannot be fixed — the deck
    // renders correctly and the build goes red anyway. #124 hit this for real.
    const slide = {
      name: 'fixture.md',
      text: '![bg right:34%](assets/generated/hero.png)\n\n## A slide\n',
    }

    expect(auditDeck(slide, [], ledger).orphans).toEqual([])
  })

  it('still reads a figure caption, so a number cannot hide in an alt-string', () => {
    // The exemption is all-or-nothing on purpose: only an alt made *entirely* of
    // Marp keywords is skipped. Prose in an alt is still prose.
    const slide = {
      name: 'fixture.md',
      text: '![Margins improved 34% year on year](figures/x.png)\n\nMargin was 34%.\n',
    }

    expect(auditDeck(slide, [], ledger).orphans.map((orphan) => orphan.literal)).toEqual([
      '34%',
      '34%',
    ])
  })
})

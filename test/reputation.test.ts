import { describe, expect, it } from 'vitest'
import { demoUserId } from '../shared/demo'
import {
  describeStanding,
  MIN_RATED_PAIRINGS,
  noReputation,
  parseStandingBand,
  type ReputationCounts,
  SPOTTY_MISS_DENOMINATOR,
  type StandingBand,
  standingBand,
  standingRank,
} from '../shared/reputation'
import { reputationStatements } from '../worker/reputation'

/** A real account id, shaped as `crypto.randomUUID()` mints `users.id`. */
const ROBB = '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c'
const DANA = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

function counts(overrides: Partial<ReputationCounts> = {}): ReputationCounts {
  return { ...noReputation(), ...overrides }
}

const ALL_BANDS: readonly StandingBand[] = ['new', 'reliable', 'spotty']

describe('standingBand', () => {
  it('starts everybody at new', () => {
    expect(standingBand(noReputation())).toBe('new')
  })

  it('stays new until there is enough history to say anything', () => {
    const almost = MIN_RATED_PAIRINGS - 1
    expect(standingBand(counts({ splitsCompleted: almost }))).toBe('new')
    // The whole point of the floor: a buyer whose only two pairings both missed
    // is not yet called out, because a flat battery and a flake look the same.
    expect(standingBand(counts({ noShows: almost }))).toBe('new')
  })

  it('rates a buyer whose handoffs go through as reliable', () => {
    expect(standingBand(counts({ splitsCompleted: MIN_RATED_PAIRINGS }))).toBe('reliable')
    expect(standingBand(counts({ splitsCompleted: 40 }))).toBe('reliable')
  })

  it('forgives the occasional miss once there is a record to weigh it against', () => {
    // 1 miss in 10 pairings is under the one-in-five line.
    expect(standingBand(counts({ splitsCompleted: 9, noShows: 1 }))).toBe('reliable')
  })

  it('bands a buyer who misses more than one in five as spotty', () => {
    const misses = 2
    const pairings = misses * SPOTTY_MISS_DENOMINATOR
    expect(standingBand(counts({ splitsCompleted: pairings - misses, noShows: misses }))).toBe(
      'spotty',
    )
    expect(standingBand(counts({ splitsCompleted: 0, noShows: 3 }))).toBe('spotty')
  })

  it('counts a late cancel exactly as heavily as a no-show', () => {
    const viaNoShow = standingBand(counts({ splitsCompleted: 2, noShows: 2 }))
    const viaCancel = standingBand(counts({ splitsCompleted: 2, lateCancels: 2 }))
    const viaBoth = standingBand(counts({ splitsCompleted: 2, noShows: 1, lateCancels: 1 }))
    expect([viaNoShow, viaCancel, viaBoth]).toEqual(['spotty', 'spotty', 'spotty'])
  })

  it('is total over counters no sane row would hold', () => {
    // A hand-edited row must not be able to throw inside the pairing path.
    expect(standingBand(counts({ splitsCompleted: -5, noShows: -2 }))).toBe('new')
    expect(standingBand(counts({ splitsCompleted: Number.NaN, noShows: 9 }))).toBe('spotty')
    expect(standingBand(counts({ splitsCompleted: 4.7 }))).toBe('reliable')
  })
})

describe('describeStanding', () => {
  it('never puts a number on screen, for any band', () => {
    // The acceptance criterion this guards: a band, never a count a stranger
    // could hold over someone.
    for (const band of ALL_BANDS) {
      const { label, detail } = describeStanding(band)
      expect(label).not.toMatch(/\d/)
      expect(detail).not.toMatch(/\d/)
      expect(label.length).toBeGreaterThan(0)
      expect(detail.length).toBeGreaterThan(0)
    }
  })

  it('reads an unrecognised band as new rather than rendering it', () => {
    expect(describeStanding('immaculate')).toEqual(describeStanding('new'))
    expect(describeStanding(undefined)).toEqual(describeStanding('new'))
    expect(describeStanding({ band: 'reliable' })).toEqual(describeStanding('new'))
  })

  it('gives each band its own words', () => {
    const labels = new Set(ALL_BANDS.map((band) => describeStanding(band).label))
    expect(labels.size).toBe(ALL_BANDS.length)
  })
})

describe('parseStandingBand', () => {
  it('passes the three real bands through', () => {
    for (const band of ALL_BANDS) expect(parseStandingBand(band)).toBe(band)
  })

  it('answers new for anything else', () => {
    expect(parseStandingBand('perfect')).toBe('new')
    expect(parseStandingBand(2)).toBe('new')
    expect(parseStandingBand(null)).toBe('new')
  })
})

describe('standingRank', () => {
  it('prefers reliable over unknown over spotty', () => {
    expect(standingRank('reliable')).toBeGreaterThan(standingRank('new'))
    expect(standingRank('new')).toBeGreaterThan(standingRank('spotty'))
  })

  it('ranks an absent band exactly with new, so nothing changes without data', () => {
    expect(standingRank(undefined)).toBe(standingRank('new'))
  })
})

describe('reputationStatements', () => {
  it('bumps exactly one counter per event', () => {
    const now = 1_700_000_000_000
    const [completed] = reputationStatements([{ userId: ROBB, event: 'completed' }], now)
    expect(completed.params).toEqual([ROBB, 1, 0, 0, now])

    const [noShow] = reputationStatements([{ userId: ROBB, event: 'no_show' }], now)
    expect(noShow.params).toEqual([ROBB, 0, 1, 0, now])

    const [lateCancel] = reputationStatements([{ userId: ROBB, event: 'late_cancel' }], now)
    expect(lateCancel.params).toEqual([ROBB, 0, 0, 1, now])
  })

  it('adds to the stored row rather than replacing it', () => {
    const [statement] = reputationStatements([{ userId: ROBB, event: 'completed' }], 1)
    expect(statement.sql).toContain('ON CONFLICT (user_id) DO UPDATE')
    expect(statement.sql).toContain(
      'splits_completed = user_reputation.splits_completed + excluded.splits_completed',
    )
  })

  it('never interpolates a column name into the SQL', () => {
    const shapes = new Set(
      (['completed', 'no_show', 'late_cancel'] as const).map(
        (event) => reputationStatements([{ userId: ROBB, event }], 1)[0].sql,
      ),
    )
    // One statement shape for all three events: which counter moves is a bound
    // value, so no event can ever name a column.
    expect(shapes.size).toBe(1)
  })

  it('writes one statement per buyer of a completed split', () => {
    const statements = reputationStatements(
      [
        { userId: ROBB, event: 'completed' },
        { userId: DANA, event: 'completed' },
      ],
      1,
    )
    expect(statements).toHaveLength(2)
    expect(statements.map((s) => s.params[0])).toEqual([ROBB, DANA])
  })

  it('counts nothing against a demo pairing', () => {
    const statements = reputationStatements(
      [
        { userId: demoUserId('11111111-2222-4333-8444-555555555555'), event: 'no_show' },
        { userId: DANA, event: 'completed' },
      ],
      1,
    )
    expect(statements).toHaveLength(1)
    expect(statements[0].params[0]).toBe(DANA)
  })

  it('drops an identity that names nobody', () => {
    expect(reputationStatements([{ userId: '', event: 'no_show' }], 1)).toEqual([])
    expect(reputationStatements([{ userId: 'user-robb', event: 'completed' }], 1)).toEqual([])
  })
})

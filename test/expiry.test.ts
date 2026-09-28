import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPIRY_WINDOWS,
  type ExpiryWindows,
  matchDeadline,
  nextAlarmAt,
  planSweep,
  type QueueEntry,
  queueDeadline,
  queueWarnAt,
  resolveWindows,
} from '../shared/expiry'

const NOW = 1_700_000_000_000

/** Short round windows so the arithmetic in each test is readable. */
const WINDOWS: ExpiryWindows = {
  queueIdleMs: 60_000,
  queueWarnLeadMs: 15_000,
  matchTimeoutMs: 30_000,
}

function entry(id: string, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return { id, lastSeenAt: NOW, warned: false, ...overrides }
}

describe('resolveWindows', () => {
  it('falls back when a var is unset', () => {
    expect(resolveWindows({})).toEqual(DEFAULT_EXPIRY_WINDOWS)
  })

  it('defaults to 15 minutes idle and a 10 minute unconfirmed match', () => {
    expect(DEFAULT_EXPIRY_WINDOWS.queueIdleMs).toBe(15 * 60_000)
    expect(DEFAULT_EXPIRY_WINDOWS.matchTimeoutMs).toBe(10 * 60_000)
  })

  it('keeps sane values as given', () => {
    expect(resolveWindows(WINDOWS)).toEqual(WINDOWS)
  })

  it('refuses a zero or negative window, which would expire a buyer on arrival', () => {
    const resolved = resolveWindows({ queueIdleMs: 0, matchTimeoutMs: -5_000 })
    expect(resolved.queueIdleMs).toBeGreaterThan(0)
    expect(resolved.matchTimeoutMs).toBeGreaterThan(0)
  })

  it('ignores NaN from an unparseable var', () => {
    expect(resolveWindows({ queueIdleMs: Number.NaN }).queueIdleMs).toBe(
      DEFAULT_EXPIRY_WINDOWS.queueIdleMs,
    )
  })

  it('never lets the warning lead exceed the window it warns about', () => {
    const resolved = resolveWindows({ queueIdleMs: 10_000, queueWarnLeadMs: 60_000 })
    expect(resolved.queueWarnLeadMs).toBe(10_000)
    expect(queueWarnAt(entry('a'), resolved)).toBeGreaterThanOrEqual(NOW)
  })

  it('allows no warning at all', () => {
    expect(resolveWindows({ queueWarnLeadMs: 0 }).queueWarnLeadMs).toBe(0)
  })
})

describe('deadlines', () => {
  it('counts the queue window from the last sign of life, not the join', () => {
    const pinged = entry('a', { lastSeenAt: NOW + 30_000 })
    expect(queueDeadline(pinged, WINDOWS)).toBe(NOW + 90_000)
  })

  it('warns a lead time ahead of the drop', () => {
    expect(queueWarnAt(entry('a'), WINDOWS)).toBe(NOW + 45_000)
  })

  it('counts a match window from when it was struck', () => {
    expect(matchDeadline({ matchId: 'm', createdAt: NOW }, WINDOWS)).toBe(NOW + 30_000)
  })
})

describe('planSweep', () => {
  it('does nothing, and asks for no alarm, in an empty cell', () => {
    expect(planSweep(NOW, [], [], WINDOWS)).toEqual({
      warn: [],
      expire: [],
      cancel: [],
      nextDueAt: null,
    })
  })

  it('leaves a fresh entry alone and wakes up in time to warn it', () => {
    const plan = planSweep(NOW, [entry('a')], [], WINDOWS)
    expect(plan.warn).toEqual([])
    expect(plan.expire).toEqual([])
    expect(plan.nextDueAt).toBe(NOW + 45_000)
  })

  it('warns an entry once it is inside the lead time', () => {
    const plan = planSweep(NOW + 45_000, [entry('a')], [], WINDOWS)
    expect(plan.warn).toEqual(['a'])
    expect(plan.expire).toEqual([])
    // Warned now, so the next thing owed to them is the drop itself.
    expect(plan.nextDueAt).toBe(NOW + 60_000)
  })

  it('does not warn the same entry twice', () => {
    const plan = planSweep(NOW + 50_000, [entry('a', { warned: true })], [], WINDOWS)
    expect(plan.warn).toEqual([])
    expect(plan.nextDueAt).toBe(NOW + 60_000)
  })

  it('expires an entry that has gone quiet for the whole window', () => {
    const plan = planSweep(NOW + 60_000, [entry('a')], [], WINDOWS)
    expect(plan.expire).toEqual(['a'])
    expect(plan.warn).toEqual([])
    // The entry is about to be gone, so it must not hold an alarm open.
    expect(plan.nextDueAt).toBeNull()
  })

  it('expires an entry that was warned and still said nothing', () => {
    const plan = planSweep(NOW + 61_000, [entry('a', { warned: true })], [], WINDOWS)
    expect(plan.expire).toEqual(['a'])
  })

  it('spares an entry that pinged after being warned', () => {
    // The ping is what resets both the clock and the warning.
    const refreshed = entry('a', { lastSeenAt: NOW + 50_000, warned: false })
    const plan = planSweep(NOW + 55_000, [refreshed], [], WINDOWS)
    expect(plan.expire).toEqual([])
    expect(plan.warn).toEqual([])
    expect(plan.nextDueAt).toBe(NOW + 95_000)
  })

  it('judges every entry on its own clock', () => {
    const plan = planSweep(
      NOW + 60_000,
      [
        entry('gone', { lastSeenAt: NOW }),
        entry('warn-me', { lastSeenAt: NOW + 10_000 }),
        entry('fresh', { lastSeenAt: NOW + 55_000 }),
      ],
      [],
      WINDOWS,
    )
    expect(plan.expire).toEqual(['gone'])
    expect(plan.warn).toEqual(['warn-me'])
    // Sooner of: warn-me's drop (70s) and fresh's warning (100s).
    expect(plan.nextDueAt).toBe(NOW + 70_000)
  })

  it('cancels a match nobody confirmed inside the window', () => {
    const plan = planSweep(NOW + 30_000, [], [{ matchId: 'm', createdAt: NOW }], WINDOWS)
    expect(plan.cancel).toEqual(['m'])
    expect(plan.nextDueAt).toBeNull()
  })

  it('leaves a young match alone and wakes up for its deadline', () => {
    const plan = planSweep(NOW + 1_000, [], [{ matchId: 'm', createdAt: NOW }], WINDOWS)
    expect(plan.cancel).toEqual([])
    expect(plan.nextDueAt).toBe(NOW + 30_000)
  })

  it('takes the earliest deadline across queue and matches', () => {
    const plan = planSweep(NOW, [entry('a')], [{ matchId: 'm', createdAt: NOW + 5_000 }], WINDOWS)
    // The match's deadline (35s) lands before the queue warning (45s).
    expect(plan.nextDueAt).toBe(NOW + 35_000)
  })

  it('never expires a buyer early when the windows are the shipped defaults', () => {
    const fourteenMinutes = NOW + 14 * 60_000
    const plan = planSweep(fourteenMinutes, [entry('a')], [], DEFAULT_EXPIRY_WINDOWS)
    expect(plan.expire).toEqual([])
    expect(plan.warn).toEqual(['a'])
  })
})

describe('nextAlarmAt', () => {
  it('asks for no alarm when nothing is pending', () => {
    expect(nextAlarmAt(NOW, planSweep(NOW, [], [], WINDOWS))).toBeNull()
  })

  it('arms the alarm for the next deadline', () => {
    expect(nextAlarmAt(NOW, planSweep(NOW, [entry('a')], [], WINDOWS))).toBe(NOW + 45_000)
  })

  it('fires immediately when work is already due, so a missed alarm is caught up', () => {
    const overdue = planSweep(NOW + 120_000, [entry('a')], [], WINDOWS)
    expect(overdue.expire).toEqual(['a'])
    expect(nextAlarmAt(NOW + 120_000, overdue)).toBe(NOW + 120_000)
  })
})

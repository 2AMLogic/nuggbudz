import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolState } from '../src/hooks/usePool'
import { usePool } from '../src/hooks/usePool'

/**
 * The one thing `usePool` has to get right without a socket in hand: an
 * upgrade-refusal probe that is still in flight after the connection it was
 * asking about is gone.
 *
 * A refused upgrade is the only path in the hook whose answer arrives over a
 * *second* channel — a plain `fetch`, because a browser never shows the client
 * the body of a non-101 response (#105) — so it is the only answer that can land
 * on state belonging to something else. The guard is a generation counter, and
 * until #178 it was bumped by `connect` alone, which covered the callers that
 * reconnect at once and not the one that does not: sign-out leaves the pool and
 * reconnects a `signOut()` round trip later.
 *
 * Driven against a hand-rolled stand-in for the four React hooks `usePool`
 * uses, which is what lets the sequence be replayed in plain Node with no DOM.
 * The stand-in mounts once and never re-renders, which is faithful here because
 * every callback the assertions touch depends only on stable refs — and it is
 * deliberately all the stand-in does. Nothing below asserts anything about
 * React, a real socket or a real screen: a lost connection through the actual
 * Durable Object is `pnpm smoke`, and what a buyer sees is `pnpm test:e2e`.
 */

interface Slot {
  v?: unknown
  current?: unknown
  fn?: unknown
  deps?: unknown[]
}

let slots: Slot[] = []
let cursor = 0
let effects: (() => void)[] = []

function sameDeps(a: unknown[] | undefined, b: unknown[]): boolean {
  return a !== undefined && a.length === b.length && a.every((value, i) => value === b[i])
}

vi.mock('react', () => ({
  useState: <T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] => {
    const i = cursor++
    slots[i] ??= { v: initial }
    const slot = slots[i]
    return [
      slot.v as T,
      (next) => {
        slot.v = typeof next === 'function' ? (next as (prev: T) => T)(slot.v as T) : next
      },
    ]
  },
  useRef: <T>(initial: T): { current: T } => {
    const i = cursor++
    slots[i] ??= { current: initial }
    return slots[i] as { current: T }
  },
  useCallback: <T>(fn: T, deps: unknown[]): T => {
    const i = cursor++
    if (!sameDeps(slots[i]?.deps, deps)) slots[i] = { fn, deps }
    return slots[i].fn as T
  },
  useEffect: (fn: () => void, deps: unknown[]): void => {
    const i = cursor++
    if (sameDeps(slots[i]?.deps, deps)) return
    slots[i] = { deps }
    effects.push(fn)
  },
}))

/** Enough of a `WebSocket` for the hook: a url, a close, and hooks to fire. */
class StandInSocket {
  static readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    sockets.push(this)
  }
  close(): void {
    this.readyState = 3
  }
}

let sockets: StandInSocket[] = []
let probeCount = 0
let answerProbe: (() => void) | null = null

/** Settle the probe's promise chain without waiting on a timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('usePool: a probe that outlives its connection', () => {
  let pool: ReturnType<typeof usePool>
  let state: Slot

  beforeEach(() => {
    slots = []
    cursor = 0
    effects = []
    sockets = []
    probeCount = 0
    answerProbe = null

    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5199' },
      setInterval: () => 1,
      clearInterval: () => undefined,
    })
    vi.stubGlobal('WebSocket', StandInSocket)
    // The probe, held open so a test decides when it lands. Answered with the
    // 429 the upgrade limiter sends, which is the message worth not showing.
    vi.stubGlobal('fetch', () => {
      probeCount += 1
      return new Promise((resolve) => {
        answerProbe = () => resolve({ status: 429, headers: { get: () => '30' } })
      })
    })

    pool = usePool()
    state = slots[0]
    for (const effect of effects) effect()
  })

  /** A seat whose upgrade was refused: `close` fired and `open` never did. */
  async function refusedJoin(): Promise<void> {
    pool.join({ dealId: 'nuggs-20' })
    expect(sockets).toHaveLength(1)
    sockets[0].onclose?.()
    await flush()
    expect(probeCount).toBe(1)
    expect((state.v as PoolState).error).toBeNull()
  }

  it('says what the refusal was when nobody has left', async () => {
    // The positive control, and the reason the two below cannot pass by simply
    // never reporting anything: this is the path #105 exists for.
    await refusedJoin()
    answerProbe?.()
    await flush()
    expect((state.v as PoolState).error).toContain('Too many connection attempts')
  })

  it('drops the answer when the seat was left before it landed', async () => {
    await refusedJoin()

    // Sign-out: `pool.leave()`, then a `signOut()` round trip before anything
    // reconnects. Nothing is waiting on the probe any more.
    pool.leave()
    expect((state.v as PoolState).stage).toBe('idle')

    answerProbe?.()
    await flush()
    expect((state.v as PoolState).error).toBeNull()
  })

  it('drops the answer when a newer connection has started', async () => {
    await refusedJoin()

    pool.join({ dealId: 'nuggs-20' })
    expect(sockets).toHaveLength(2)

    answerProbe?.()
    await flush()
    expect((state.v as PoolState).error).toBeNull()
  })
})

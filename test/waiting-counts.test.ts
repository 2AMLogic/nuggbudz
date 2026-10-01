import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
import { ACTIVE_DEALS } from '../shared/deals'
import type { LatLng } from '../shared/geo'
import type {
  MarketMessage,
  ServerMessage,
  WaitingMessage,
  WelcomeMessage,
} from '../shared/protocol'
import type { Env } from '../worker/env'
import { NuggPool } from '../worker/pool'

/**
 * #94: `welcome` and `waiting` used to carry a field of one name, `waiting`, that
 * counted two different things — the market around a socket with no seat (any
 * deal, never the recipient) and the queue a seated buyer stands in (their deal,
 * including them). The client wrote both into one slot.
 *
 * These pin the *relationship* between the counts rather than any number, so a
 * change that makes them silently converge or drift further apart fails here.
 * They drive `NuggPool`'s own upgrade and join paths against fakes, the way
 * `test/seat.test.ts` does; the real runtime is `pnpm smoke`'s.
 */

const MY_DEAL = ACTIVE_DEALS[0]?.id ?? ''
/**
 * A deal that is not the newcomer's. The deal axis is the subject here, not a
 * way to keep scenarios apart — the other buyer stands on it precisely so the two
 * counts disagree. It is seeded onto a seated buyer's attachment rather than
 * picked from the catalogue, because the catalogue offers one deal today and
 * which ones it offers is a product decision this test must not depend on (#57).
 */
const OTHER_DEAL = 'a-deal-that-is-not-mine'

interface FakeSocket {
  sent: ServerMessage[]
  tags: string[]
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
  send(raw: string): void
}

function fakeSocket(attachment: unknown = null, tags: string[] = []): FakeSocket {
  let stored: unknown = structuredClone(attachment)
  return {
    sent: [],
    tags,
    serializeAttachment(value) {
      stored = structuredClone(value)
    },
    deserializeAttachment() {
      return stored
    },
    send(raw) {
      this.sent.push(JSON.parse(raw) as ServerMessage)
    },
  }
}

function harness() {
  const sockets: FakeSocket[] = []
  const cell = new Map<string, unknown>()
  const ctx = {
    getWebSockets: (tag?: string) =>
      tag === undefined ? sockets : sockets.filter((socket) => socket.tags.includes(tag)),
    acceptWebSocket: (socket: FakeSocket, tags: string[] = []) => {
      socket.tags.push(...tags)
      sockets.push(socket)
    },
    storage: {
      get: async (key: string) => cell.get(key),
      put: async (key: string, value: unknown) => void cell.set(key, value),
      delete: async (key: string) => cell.delete(key),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...cell].filter(([key]) => key.startsWith(prefix))),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
  }
  // D1 answers every standing read with nothing, which ranks everybody `new`.
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) }
  const pool = new NuggPool(
    ctx as unknown as DurableObjectState,
    { DB: db, ALLOW_UNCHARGED_PAIRING: '1' } as unknown as Env,
  )

  /** Upgrade a socket through the pool's own `fetch`, as the Worker would. */
  async function connect(userId: string, at: LatLng): Promise<FakeSocket> {
    const params = new URLSearchParams({
      userId,
      displayName: 'Someone',
      lat: String(at.lat),
      lng: String(at.lng),
      locationSource: 'client',
      cell: '9tb',
    })
    const before = sockets.length
    await pool.fetch(
      new Request(`https://nugg-pool.internal/api/pool/ws?${params}`, {
        headers: { Upgrade: 'websocket' },
      }),
    )
    const socket = sockets[before]
    if (socket === undefined) throw new Error('the pool accepted no socket')
    return socket
  }

  const join = (socket: FakeSocket) =>
    pool.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ type: 'join', dealId: MY_DEAL }),
    )

  /** Seat a buyer on `dealId` — joined for real, then moved off the offered deal if asked. */
  async function seat(socket: FakeSocket, dealId: string): Promise<void> {
    await join(socket)
    const state = socket.deserializeAttachment() as { status: string; dealId: string }
    expect(state.status).toBe('waiting')
    socket.serializeAttachment({ ...state, dealId })
  }

  return { connect, join, seat }
}

function only<T extends ServerMessage['type']>(
  socket: FakeSocket,
  type: T,
): Extract<ServerMessage, { type: T }> {
  const found = socket.sent.filter((message) => message.type === type)
  expect(found, `${type} frames`).toHaveLength(1)
  return found[0] as Extract<ServerMessage, { type: T }>
}

/** What a socket was told at upgrade: `welcome`, then the `market` straight after. */
function arrival(socket: FakeSocket): { welcome: WelcomeMessage; market: MarketMessage } {
  expect(socket.sent.slice(0, 2).map((message) => message.type)).toEqual(['welcome', 'market'])
  return { welcome: only(socket, 'welcome'), market: socket.sent[1] as MarketMessage }
}

const sum = (byDeal: Record<string, number>) => Object.values(byDeal).reduce((a, b) => a + b, 0)

let account = 0
const nextAccount = () => `00000000-0000-4000-8000-${String(++account).padStart(12, '0')}`

describe('welcome.marketWaiting and waiting.waiting (#94)', () => {
  beforeEach(() => {
    // The pool's upgrade path hands back a 101, which Node's own `Response`
    // refuses to construct; and `WebSocketPair` is a Workers global. Both are
    // plumbing around the frames under test, faked as plainly as possible.
    vi.stubGlobal(
      'Response',
      class {
        readonly status: number
        constructor(_body: unknown, init?: { status?: number }) {
          this.status = init?.status ?? 200
        }
      },
    )
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = fakeSocket()
        1 = fakeSocket()
      },
    )
    vi.stubGlobal('fetch', async () => {
      throw new Error('the pool tried to reach the network')
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['an empty market', []],
    ['a market with somebody on another deal', [OTHER_DEAL]],
  ] as const)('relates the two counts in %s', async (_label, others) => {
    const { connect, join, seat } = harness()
    // Every other buyer stands inside the radius but on another deal, so none
    // of them is a candidate and the newcomer is left queued rather than matched.
    for (const dealId of others)
      await seat(await connect(nextAccount(), FIXTURE_COORDS.nell), dealId)
    // Outside the radius, on the newcomer's own deal: counted by neither.
    await seat(await connect(nextAccount(), FIXTURE_COORDS.lee), MY_DEAL)

    const me = await connect(nextAccount(), FIXTURE_COORDS.kim)
    const { welcome, market } = arrival(me)
    await join(me)
    const queued: WaitingMessage = only(me, 'waiting')

    // The welcome figure is the market count, by construction: any deal, and
    // never the socket being told, which at upgrade holds no seat.
    expect(welcome.marketWaiting).toBe(market.waiting)
    expect(welcome.marketWaiting).toBe(sum(market.byDeal))
    expect(welcome.marketWaiting).toBe(others.length)
    // The queue count is one deal's share of that market, plus the buyer told.
    expect(queued.waiting).toBe((market.byDeal[MY_DEAL] ?? 0) + 1)
    // The old field is gone, so nothing can read one count under the other's name.
    expect('waiting' in welcome).toBe(false)
  })

  it('counts you in everyone else’s market and never in your own', async () => {
    const { connect, join, seat } = harness()
    await seat(await connect(nextAccount(), FIXTURE_COORDS.nell), OTHER_DEAL)

    const me = await connect(nextAccount(), FIXTURE_COORDS.kim)
    const { welcome, market } = arrival(me)
    const mine = welcome.marketWaiting
    await join(me)
    expect(only(me, 'waiting').waiting).toBe((market.byDeal[MY_DEAL] ?? 0) + 1)

    // A newcomer beside me sees the market I saw, plus me — on a deal that is
    // not necessarily theirs.
    const next = await connect(nextAccount(), FIXTURE_COORDS.moss)
    expect(arrival(next).welcome.marketWaiting).toBe(mine + 1)
  })
})

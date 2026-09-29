import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
import { ACTIVE_DEALS } from '../shared/deals'
import { demoUserId } from '../shared/demo'
import { seatVerdict } from '../shared/identity'
import type { ServerMessage } from '../shared/protocol'
import { anonSocketTag } from '../shared/ratelimit'
import type { Env } from '../worker/env'
import { NuggPool } from '../worker/pool'

/**
 * #150: sign-in moved from the socket to the seat.
 *
 * The socket is open to everybody now, so the whole of "an anonymous browser on
 * a charged deployment cannot pair for free" rests on one server-side answer in
 * the `join` path. These drive `NuggPool`'s own `webSocketMessage` against fake
 * sockets — the stub in `test/stubs/cloudflare-workers.ts` is a bare base class,
 * and everything else here is an ordinary fake — because a gate that is green as
 * a pure function and absent from the handler is this repo's recurring defect.
 * The real runtime is `pnpm smoke`'s and `pnpm demo-check`'s.
 */

const ACCOUNT = '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c'
const OTHER_ACCOUNT = '4a8c2b3d-0e5f-4a7b-9c2d-3e4f5a6b7c8d'
const ANON = demoUserId('a'.repeat(43))
const OTHER_ANON = demoUserId('b'.repeat(43))
const DEAL_ID = ACTIVE_DEALS[0]?.id ?? ''

describe('seatVerdict', () => {
  it('seats an account whatever the demo flag says', () => {
    expect(seatVerdict(ACCOUNT, false)).toBe('seat')
    expect(seatVerdict(ACCOUNT, true)).toBe('seat')
  })

  it('seats an anonymous identity only when anonymous seats are allowed', () => {
    expect(seatVerdict(ANON, false)).toBe('sign_in_required')
    expect(seatVerdict(ANON, true)).toBe('seat')
  })

  it('refuses an id that names nobody, flag or no flag — the fail-closed direction', () => {
    for (const bogus of ['', 'demo:', 'smoke-user-robb', undefined, null, 7]) {
      expect(seatVerdict(bogus, false)).toBe('sign_in_required')
      expect(seatVerdict(bogus, true)).toBe('sign_in_required')
    }
  })
})

interface FakeSocket {
  sent: ServerMessage[]
  tags: string[]
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
  send(raw: string): void
}

function fakeSocket(attachment: unknown, tags: string[] = []): FakeSocket {
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

/** An idle socket as the Worker would have seated it, standing at `at`. */
function idle(userId: string, at: { lat: number; lng: number }): FakeSocket {
  return fakeSocket({
    status: 'idle',
    connId: crypto.randomUUID(),
    userId,
    name: 'Someone',
    cell: '9q9',
    origin: at,
    locationSource: 'client',
  })
}

/**
 * A pool over in-memory sockets and storage. `env` is the deployment shape under
 * test; D1 answers every standing read with nothing, which ranks everybody as
 * `new` exactly as a reputation outage would.
 */
function poolWith(sockets: FakeSocket[], env: Partial<Env>) {
  const cell = new Map<string, unknown>()
  const ctx = {
    getWebSockets: (tag?: string) =>
      tag === undefined ? sockets : sockets.filter((socket) => socket.tags.includes(tag)),
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
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  }
  const pool = new NuggPool(
    ctx as unknown as DurableObjectState,
    { DB: db, ...env } as unknown as Env,
  )
  const join = (socket: FakeSocket) =>
    pool.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ type: 'join', dealId: DEAL_ID }),
    )
  return { pool, cell, join }
}

const types = (socket: FakeSocket) => socket.sent.map((message) => message.type)
const statusOf = (socket: FakeSocket) =>
  (socket.deserializeAttachment() as { status: string }).status

/** Stripe secrets bound: the deployment shape in which a free pair would cost money. */
const CHARGED: Partial<Env> = {
  STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_not_a_real_secret',
  // Nothing listens here — a charge that was attempted would fail loudly.
  STRIPE_API_BASE: 'http://127.0.0.1:9/v1',
}

describe('the join gate (#150)', () => {
  const HERE = FIXTURE_COORDS.robb
  const NEAR = FIXTURE_COORDS.dana
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Any outbound request from the pool here is a charge being attempted.
    fetchSpy = vi.fn(async () => {
      throw new Error('the pool tried to reach the network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('refuses an anonymous seat on a charged deployment, on the wire, and seats nothing', async () => {
    const anon = idle(ANON, HERE)
    const { join, cell } = poolWith([anon], CHARGED)

    await join(anon)

    const refusal = anon.sent.find((message) => message.type === 'error')
    expect(refusal).toMatchObject({ type: 'error', code: 'sign_in_required' })
    expect(statusOf(anon)).toBe('idle')
    expect(types(anon)).not.toContain('waiting')
    expect(cell.size).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses it on an uncharged deployment too — the flag decides, not the money', async () => {
    const anon = idle(ANON, HERE)
    const { join } = poolWith([anon], { ALLOW_UNCHARGED_PAIRING: '1' })

    await join(anon)

    expect(anon.sent.at(-1)).toMatchObject({ type: 'error', code: 'sign_in_required' })
    expect(statusOf(anon)).toBe('idle')
  })

  it('still seats a signed-in account with demo pairing off', async () => {
    const buyer = idle(ACCOUNT, HERE)
    const { join } = poolWith([buyer], { ALLOW_UNCHARGED_PAIRING: '1' })

    await join(buyer)

    expect(types(buyer)).toContain('waiting')
    expect(types(buyer)).not.toContain('error')
    expect(statusOf(buyer)).toBe('waiting')
  })

  it('with demo pairing on, pairs two anonymous buyers as a demo pair that never reaches Stripe', async () => {
    const a = idle(ANON, HERE)
    const b = idle(OTHER_ANON, NEAR)
    const { join, cell } = poolWith([a, b], { ...CHARGED, ALLOW_DEMO_PAIRING: '1' })

    await join(a)
    await join(b)

    const matchedA = a.sent.find((message) => message.type === 'matched')
    const matchedB = b.sent.find((message) => message.type === 'matched')
    expect(matchedA?.type).toBe('matched')
    expect(matchedB?.type).toBe('matched')
    // `paymentDisposition` answered `demo` before the secrets were read: the code
    // is out at match time, nobody is asked to pay, and nothing left the pool.
    const record = [...cell.values()][0] as { disposition: string }
    expect(record.disposition).toBe('demo')
    expect([...types(a), ...types(b)]).not.toContain('payment_required')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never pairs an anonymous seat with an account on a strict deployment', async () => {
    // The pair the gate exists to prevent: one real account queued and waiting,
    // one anonymous browser beside them. A seat for the second would be a match
    // `paymentDisposition` answers `demo` — a free box for the account holder.
    const buyer = idle(ACCOUNT, HERE)
    const anon = idle(ANON, NEAR)
    const { join } = poolWith([buyer, anon], CHARGED)

    await join(buyer)
    await join(anon)

    expect(types(buyer)).not.toContain('matched')
    expect(types(anon)).not.toContain('matched')
    expect(anon.sent.at(-1)).toMatchObject({ code: 'sign_in_required' })
  })
})

describe('what a socket without a seat is told (#150)', () => {
  it('counts the queue within its radius and never carries the roster', async () => {
    const HERE = FIXTURE_COORDS.kim
    const browser = idle(ANON, FIXTURE_COORDS.nell)
    // Outside the radius (three miles off): not counted.
    const faraway = idle(OTHER_ACCOUNT, FIXTURE_COORDS.lee)
    const buyer = idle(ACCOUNT, HERE)
    const { join } = poolWith([browser, faraway, buyer], { ALLOW_UNCHARGED_PAIRING: '1' })

    await join(faraway)
    await join(buyer)

    const markets = browser.sent.filter((message) => message.type === 'market')
    expect(markets.length).toBeGreaterThan(0)
    const latest = markets.at(-1)
    expect(latest).toEqual({ type: 'market', waiting: 1, byDeal: { [DEAL_ID]: 1 } })
    // The whole privacy claim, asserted on the frames themselves: no `buddies`,
    // no names, nothing positional about anybody else.
    for (const message of browser.sent) {
      expect(message.type).not.toBe('waiting')
      expect(JSON.stringify(message)).not.toContain('buddies')
      expect(JSON.stringify(message)).not.toContain('Someone')
    }
    // The seated buyer still gets the roster — the dots are what a seat earns.
    const waiting = buyer.sent.filter((message) => message.type === 'waiting').at(-1)
    expect(waiting).toMatchObject({ type: 'waiting', waiting: 1 })
    expect(waiting && 'buddies' in waiting).toBe(true)
  })
})

describe('the anonymous socket cap (#150)', () => {
  it('refuses an anonymous upgrade past the per-address cap, before a socket exists', async () => {
    const key = 'ip4:203.0.113.7'
    const held = Array.from({ length: 2 }, () => idle(ANON, FIXTURE_COORDS.robb))
    for (const socket of held) socket.tags.push(anonSocketTag(key))
    const { pool } = poolWith(held, { POOL_ANON_SOCKETS_PER_IP: '2' })

    const params = new URLSearchParams({
      userId: ANON,
      displayName: 'Guest',
      lat: String(FIXTURE_COORDS.robb.lat),
      lng: String(FIXTURE_COORDS.robb.lng),
      locationSource: 'client',
      cell: '9qc',
      anonKey: key,
    })
    const response = await pool.fetch(
      new Request(`https://nugg-pool.internal/api/pool/ws?${params}`, {
        headers: { Upgrade: 'websocket' },
      }),
    )
    expect(response.status).toBe(429)
  })
})

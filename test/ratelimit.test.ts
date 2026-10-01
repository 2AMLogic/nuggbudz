import { describe, expect, it } from 'vitest'
import { demoUserId } from '../shared/demo'
import {
  ANON_VENUE_MINUTE,
  accountSocketTag,
  anonAddressRateKey,
  anonAddressUpgradeLimit,
  anonSocketTag,
  BUYER_BUSIEST_MINUTE,
  buyerRateKey,
  buyerUpgradeLimit,
  clientKey,
  combineVerdicts,
  enforceableWindowLimit,
  parseHits,
  slidingWindow,
  UPGRADES_PER_PAIRING,
  type UpgradeCaller,
  underConcurrencyCap,
  upgradeWindows,
} from '../shared/ratelimit'
import type { Env } from '../worker/env'
import { checkUpgradeRate } from '../worker/ratelimit'
// The deployed configuration, read as text (it is JSONC): the figures below are
// asserted against what the Worker is actually given.
import wranglerSource from '../wrangler.jsonc?raw'

// Read from wrangler.jsonc, so the tests below exercise the limits that ship.
const WINDOW_MS = wranglerInt('POOL_UPGRADE_WINDOW_SECONDS') * 1000
const LIMIT = wranglerInt('POOL_UPGRADE_LIMIT')
const ANON_LIMIT = wranglerInt('POOL_ANON_UPGRADE_LIMIT')
const CAP = 3

/**
 * Model one cell's live sockets the way NuggPool counts them: by hibernation
 * tag. Returns whether the socket was accepted.
 */
function openSocket(live: Map<string, number>, userId: string, cap = CAP): boolean {
  const tag = accountSocketTag(userId)
  const open = live.get(tag) ?? 0
  if (!underConcurrencyCap(open, cap)) return false
  live.set(tag, open + 1)
  return true
}

/** Replay attempts through the window the way the Worker does, returning each verdict. */
function replay(times: number[], limit = LIMIT, windowMs = WINDOW_MS) {
  let hits: number[] = []
  return times.map((now) => {
    const verdict = slidingWindow(hits, now, windowMs, limit)
    hits = verdict.hits
    return verdict
  })
}

describe('slidingWindow', () => {
  it('allows the first attempt and records it', () => {
    const v = slidingWindow([], 1_000, WINDOW_MS, LIMIT)
    expect(v).toEqual({ allowed: true, hits: [1_000], retryAfterSeconds: 0 })
  })

  it('rejects the attempt past the limit within one window', () => {
    const verdicts = replay([0, 1, 2, 3], 3)
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false])
  })

  it('does not record rejected attempts', () => {
    const v = slidingWindow([0, 1, 2], 3, WINDOW_MS, 3)
    expect(v.allowed).toBe(false)
    expect(v.hits).toEqual([0, 1, 2])
  })

  it('slides: an attempt is allowed once the oldest hit ages out', () => {
    const hits = [0, 10_000, 20_000]
    expect(slidingWindow(hits, 59_999, WINDOW_MS, 3).allowed).toBe(false)
    const v = slidingWindow(hits, 60_000, WINDOW_MS, 3)
    expect(v.allowed).toBe(true)
    expect(v.hits).toEqual([10_000, 20_000, 60_000])
  })

  it('is a true sliding window, not a fixed bucket reset at the boundary', () => {
    // A fixed 60s bucket would let 3 in at 59s and 3 more at 61s.
    const verdicts = replay([59_000, 59_001, 59_002, 61_000], 3)
    expect(verdicts.at(-1)?.allowed).toBe(false)
  })

  it('reports Retry-After as seconds until the gating hit expires', () => {
    const v = slidingWindow([0, 30_000, 45_000], 50_000, WINDOW_MS, 3)
    expect(v.allowed).toBe(false)
    expect(v.retryAfterSeconds).toBe(10)
  })

  it('never reports a Retry-After of zero on rejection', () => {
    const v = slidingWindow([0, 1, 2], 59_999.5, WINDOW_MS, 3)
    expect(v.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('ignores hits from the future so a skewed clock cannot lock a client out', () => {
    const v = slidingWindow([999_999, 999_999, 999_999], 1_000, WINDOW_MS, 3)
    expect(v.allowed).toBe(true)
    expect(v.hits).toEqual([1_000])
  })

  it('stops a socket flood from one address', () => {
    const verdicts = replay(Array.from({ length: 1_000 }, (_, i) => i * 10))
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(LIMIT)
  })
})

describe('underConcurrencyCap', () => {
  it('allows up to the cap and no further', () => {
    expect(underConcurrencyCap(0, CAP)).toBe(true)
    expect(underConcurrencyCap(CAP - 1, CAP)).toBe(true)
    expect(underConcurrencyCap(CAP, CAP)).toBe(false)
    expect(underConcurrencyCap(CAP + 10, CAP)).toBe(false)
  })
})

describe('accountSocketTag', () => {
  it('gives one account one tag and different accounts different tags', () => {
    expect(accountSocketTag('google:111')).toBe('user:google:111')
    expect(accountSocketTag('google:111')).toBe(accountSocketTag('google:111'))
    expect(accountSocketTag('google:111')).not.toBe(accountSocketTag('google:222'))
  })
})

describe('concurrent-socket cap is per account', () => {
  it('caps one account at CAP sockets in a cell', () => {
    const live = new Map<string, number>()
    const accepted = Array.from({ length: CAP + 2 }, () => openSocket(live, 'mallory'))
    expect(accepted.filter(Boolean)).toHaveLength(CAP)
    expect(accepted.slice(CAP).every((a) => !a)).toBe(true)
  })

  it('lets an honest buyer reconnect while the old socket is still closing', () => {
    const live = new Map<string, number>()
    expect(openSocket(live, 'alice')).toBe(true)
    expect(openSocket(live, 'alice')).toBe(true)
  })

  it('does not cap many accounts behind one carrier NAT against each other', () => {
    // A busy food court on one mobile carrier: every buyer egresses from the
    // same IPv4 address, which a per-IP cap would have rejected after a few.
    expect(clientKey('198.51.100.9')).toBe(clientKey('198.51.100.9'))
    const live = new Map<string, number>()
    for (let i = 0; i < 50; i++) {
      expect(openSocket(live, `buyer-${i}`)).toBe(true)
    }
  })

  it('does not let one account at its cap block a neighbour on the same IP', () => {
    const live = new Map<string, number>()
    for (let i = 0; i < CAP; i++) openSocket(live, 'mallory')
    expect(openSocket(live, 'mallory')).toBe(false)
    expect(openSocket(live, 'alice')).toBe(true)
  })
})

describe('parseHits', () => {
  it('keeps finite numbers only', () => {
    expect(parseHits([1, '2', null, Number.NaN, 3, Number.POSITIVE_INFINITY])).toEqual([1, 3])
  })

  it('treats anything but an array as no history', () => {
    expect(parseHits(null)).toEqual([])
    expect(parseHits({ 0: 1 })).toEqual([])
    expect(parseHits('[1,2]')).toEqual([])
  })
})

describe('clientKey', () => {
  it('keys IPv4 per address', () => {
    expect(clientKey('198.51.100.1')).toBe('ip4:198.51.100.1')
    expect(clientKey(' 198.51.100.1 ')).toBe('ip4:198.51.100.1')
    expect(clientKey('198.51.100.1')).not.toBe(clientKey('198.51.100.2'))
  })

  it('keys IPv6 per /64 so a host cannot rotate addresses within its prefix', () => {
    const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    const b = clientKey('2001:0db8:0001:0002::1')
    expect(a).toBe('ip6:2001:db8:1:2::/64')
    expect(b).toBe(a)
    expect(clientKey('2001:db8:1:3::1')).not.toBe(a)
  })

  it('expands compressed IPv6 forms', () => {
    expect(clientKey('::1')).toBe('ip6:0:0:0:0::/64')
    expect(clientKey('2001:db8::')).toBe('ip6:2001:db8:0:0::/64')
  })

  it('keys IPv4-mapped IPv6 as the IPv4 client it is', () => {
    expect(clientKey('::ffff:192.0.2.1')).toBe('ip4:192.0.2.1')
    expect(clientKey('::ffff:c000:201')).toBe('ip4:192.0.2.1')
  })

  it('rejects anything that is not an address', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'localhost',
      '256.1.1.1',
      '1.2.3',
      '1:2:3:4:5:6:7:8:9',
      '1::2::3',
      '12345::',
      'fe80::1%eth0',
      'x-forwarded-for',
    ]) {
      expect(clientKey(bad)).toBeNull()
    }
  })
})

/** `"NAME": "value"` out of wrangler.jsonc, as an integer. */
function wranglerInt(name: string): number {
  const found = wranglerSource.match(new RegExp(`"${name}"\\s*:\\s*"(\\d+)"`))
  if (found === null) throw new Error(`wrangler.jsonc has no integer var ${name}`)
  return Number(found[1])
}

describe('the upgrade figures are derived from a venue model (#106)', () => {
  it('deploys the buyer window the model adds up to', () => {
    expect(LIMIT).toBe(buyerUpgradeLimit())
    expect(buyerUpgradeLimit()).toBe(10)
  })

  it('deploys the anonymous address window the model adds up to', () => {
    expect(ANON_LIMIT).toBe(anonAddressUpgradeLimit())
    expect(anonAddressUpgradeLimit()).toBe(20)
  })

  it('charges a pairing for the handoff tab, which #104 made a third socket', () => {
    // Two buddies each browse and join, and the receiver's camera app opens one more.
    expect(UPGRADES_PER_PAIRING).toBe(5)
    expect(BUYER_BUSIEST_MINUTE.handoffTab).toBe(1)
    expect(BUYER_BUSIEST_MINUTE.rescan).toBeGreaterThanOrEqual(1)
  })

  it('keeps every window at a size KV can actually enforce', () => {
    // One write a second per key: a window allowing more than that drops writes,
    // under-counts, and never trips — so "raise the figure" has a ceiling.
    const windowSeconds = WINDOW_MS / 1000
    expect(LIMIT).toBeLessThanOrEqual(enforceableWindowLimit(windowSeconds))
    expect(ANON_LIMIT).toBeLessThanOrEqual(enforceableWindowLimit(windowSeconds))
  })

  it('leaves one buyer unable to exhaust an address on their own', () => {
    expect(LIMIT).toBeLessThan(ANON_LIMIT)
    // And the address fits the rush it was sized for, with nothing left over
    // that a reconnect would need: reconnects are the buyer window's.
    expect(ANON_VENUE_MINUTE.pairings * UPGRADES_PER_PAIRING + ANON_VENUE_MINUTE.browsers).toBe(
      ANON_LIMIT,
    )
  })
})

describe('upgradeWindows', () => {
  const limits = { buyer: 10, anonAddress: 20 }
  const venue = clientKey('203.0.113.7') ?? ''

  it('counts a signed-in upgrade in its account window and nowhere else', () => {
    const windows = upgradeWindows(
      { bucket: 'session', clientKey: venue, buyerId: 'acct-1' },
      limits,
    )
    expect(windows).toEqual([{ kvKey: buyerRateKey('session', 'acct-1'), limit: 10 }])
  })

  it('counts an anonymous upgrade with a cookie in its own window, then the address', () => {
    const buyer = demoUserId('a'.repeat(22))
    const windows = upgradeWindows(
      { bucket: 'anonymous', clientKey: venue, buyerId: buyer },
      limits,
    )
    expect(windows).toEqual([
      { kvKey: buyerRateKey('anonymous', buyer), limit: 10 },
      { kvKey: anonAddressRateKey(venue), limit: 20 },
    ])
  })

  it('counts an anonymous upgrade with no cookie by address alone', () => {
    const windows = upgradeWindows({ bucket: 'anonymous', clientKey: venue, buyerId: null }, limits)
    expect(windows).toEqual([{ kvKey: anonAddressRateKey(venue), limit: 20 }])
  })

  it('never shares a key between an account, an anonymous buyer and an address', () => {
    const keys = [
      buyerRateKey('session', 'x'),
      buyerRateKey('anonymous', 'x'),
      anonAddressRateKey('x'),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    // The anonymous address key is the one that shipped with #150, so no live
    // window resets on deploy.
    expect(anonAddressRateKey(venue)).toBe(`ratelimit:pool-ws-anon:${venue}`)
  })
})

describe('combineVerdicts', () => {
  it('allows only when every window does, and waits for the slowest to reopen', () => {
    const ok = { allowed: true, hits: [], retryAfterSeconds: 0 }
    const soon = { allowed: false, hits: [], retryAfterSeconds: 4 }
    const late = { allowed: false, hits: [], retryAfterSeconds: 40 }
    expect(combineVerdicts([ok, ok])).toEqual({ allowed: true, retryAfterSeconds: 0 })
    expect(combineVerdicts([ok, soon])).toEqual({ allowed: false, retryAfterSeconds: 4 })
    expect(combineVerdicts([late, soon, ok])).toEqual({ allowed: false, retryAfterSeconds: 40 })
    expect(combineVerdicts([])).toEqual({ allowed: true, retryAfterSeconds: 0 })
  })
})

/**
 * The real `checkUpgradeRate` against an in-memory KV, with the deployed
 * figures. Only `get` and `put` are modelled — enough for the limiter, and
 * nothing a test below asserts about the runtime.
 */
function limiter() {
  const kv = new Map<string, string>()
  const env = {
    SESSIONS: {
      get: async (key: string) => {
        const raw = kv.get(key)
        return raw === undefined ? null : JSON.parse(raw)
      },
      put: async (key: string, value: string) => {
        kv.set(key, value)
      },
    },
    POOL_UPGRADE_LIMIT: String(LIMIT),
    POOL_ANON_UPGRADE_LIMIT: String(ANON_LIMIT),
    POOL_UPGRADE_WINDOW_SECONDS: String(WINDOW_MS / 1000),
  } as unknown as Env
  let clock = 0
  // A tenth of a second apart, so every scenario below fits inside one window.
  const attempt = async (caller: UpgradeCaller) => {
    clock += 100
    return (await checkUpgradeRate(env, caller, clock)).allowed
  }
  return { kv, attempt }
}

const VENUE = clientKey('203.0.113.7') ?? ''
const signedIn = (buyerId: string): UpgradeCaller => ({
  bucket: 'session',
  clientKey: VENUE,
  buyerId,
})
const anonymous = (token: string | null): UpgradeCaller => ({
  bucket: 'anonymous',
  clientKey: VENUE,
  buyerId: token === null ? null : demoUserId(token),
})

/** Everything one completed pairing opens: both buddies browse and join, plus the handoff tab. */
function pairing(orderer: UpgradeCaller, receiver: UpgradeCaller): UpgradeCaller[] {
  return [orderer, orderer, receiver, receiver, receiver]
}

describe('one venue NAT, through the real limiter (#106)', () => {
  it('pairs fifteen signed-in couples in a minute, which the per-address window refused', async () => {
    const { attempt } = limiter()
    const all: boolean[] = []
    for (let i = 0; i < 15; i++) {
      // Every receiver also backs out of the handoff tab and scans again.
      for (const caller of [
        ...pairing(signedIn(`o-${i}`), signedIn(`r-${i}`)),
        signedIn(`r-${i}`),
      ]) {
        all.push(await attempt(caller))
      }
    }
    // Ninety upgrades from one address in one minute, three times the old ceiling.
    expect(all).toHaveLength(90)
    expect(all.every(Boolean)).toBe(true)
  })

  it("lets one signed-in buyer's busiest honest minute through", async () => {
    const { attempt } = limiter()
    const results = []
    for (let i = 0; i < buyerUpgradeLimit(); i++) results.push(await attempt(signedIn('alice')))
    expect(results.every(Boolean)).toBe(true)
  })

  it("does not let one signed-in buyer's reconnect storm touch a neighbour", async () => {
    const { attempt } = limiter()
    const storm = []
    for (let i = 0; i < 50; i++) storm.push(await attempt(signedIn('mallory')))
    expect(storm.filter(Boolean)).toHaveLength(LIMIT)
    expect(await attempt(signedIn('alice'))).toBe(true)
  })

  it("charges an anonymous buyer's refused reconnects to nobody but them", async () => {
    const { kv, attempt } = limiter()
    const storm = []
    for (let i = 0; i < 50; i++) storm.push(await attempt(anonymous('m'.repeat(22))))
    expect(storm.filter(Boolean)).toHaveLength(LIMIT)
    // The address recorded the allowed ones only, never the refusals...
    expect(parseHits(JSON.parse(kv.get(anonAddressRateKey(VENUE)) ?? '[]'))).toHaveLength(LIMIT)
    // ...so the rest of the room still has the remainder of its window.
    const room = []
    for (let i = 0; i < ANON_LIMIT - LIMIT; i++) {
      room.push(await attempt(anonymous(String(i).padStart(22, 'n'))))
    }
    expect(room.every(Boolean)).toBe(true)
  })

  it('turns away a flood from one machine with no cookie at the address window', async () => {
    const { attempt } = limiter()
    const flood = []
    for (let i = 0; i < 200; i++) flood.push(await attempt(anonymous(null)))
    expect(flood.filter(Boolean)).toHaveLength(ANON_LIMIT)
  })

  it('and one rotating a fresh demo cookie per attempt buys nothing by it', async () => {
    const { attempt } = limiter()
    const flood = []
    for (let i = 0; i < 200; i++) flood.push(await attempt(anonymous(String(i).padStart(22, 'f'))))
    expect(flood.filter(Boolean)).toHaveLength(ANON_LIMIT)
  })

  it('so a signed-out flood behind the venue NAT cannot spend a signed-in budget', async () => {
    const { attempt } = limiter()
    for (let i = 0; i < 200; i++) await attempt(anonymous(null))
    expect(await attempt(anonymous(null))).toBe(false)
    expect(await attempt(signedIn('alice'))).toBe(true)
  })

  it('counts a bystander who taps a photographed link against them, not the buddies', async () => {
    const { attempt } = limiter()
    // A bystander tapping the same link over and over runs out of their own window...
    for (let i = 0; i < 50; i++) await attempt(signedIn('bystander'))
    expect(await attempt(signedIn('bystander'))).toBe(false)
    // ...and the receiver the link was meant for still opens it.
    expect(await attempt(signedIn('receiver'))).toBe(true)
  })

  it('needs no raised POOL_UPGRADE_LIMIT for a local suite sharing the unknown address', async () => {
    // `pnpm dev` never sets CF-Connecting-IP, so every local client is `unknown`.
    // Signed-in windows are per account, so forty accounts each pairing is fine.
    const { attempt } = limiter()
    const local = (id: string): UpgradeCaller => ({
      bucket: 'session',
      clientKey: 'unknown',
      buyerId: id,
    })
    const all: boolean[] = []
    for (let i = 0; i < 40; i++) {
      for (const caller of pairing(local(`o-${i}`), local(`r-${i}`)))
        all.push(await attempt(caller))
    }
    expect(all.every(Boolean)).toBe(true)
  })

  it('anonymous sockets are still capped concurrently per address, not per identity', () => {
    // A caller with no demo cookie gets a fresh identity per socket, so the cap
    // has to key on the one thing it cannot rotate for free.
    expect(anonSocketTag('ip4:203.0.113.7')).toBe(anonSocketTag('ip4:203.0.113.7'))
    expect(anonSocketTag('ip4:203.0.113.7')).not.toBe(anonSocketTag('ip4:203.0.113.8'))
    expect(anonSocketTag('ip4:203.0.113.7')).not.toBe(accountSocketTag('ip4:203.0.113.7'))
    expect(wranglerInt('POOL_ANON_SOCKETS_PER_IP')).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import {
  accountSocketTag,
  anonSocketTag,
  clientKey,
  parseHits,
  slidingWindow,
  underConcurrencyCap,
  upgradeRateKey,
} from '../shared/ratelimit'
// The deployed configuration, read as text (it is JSONC): the figures below are
// asserted against what the Worker is actually given.
import wranglerSource from '../wrangler.jsonc?raw'

// Mirrors the defaults in wrangler.jsonc, so the demo tests below exercise the
// limits that actually ship.
const WINDOW_MS = 60_000
const LIMIT = 30
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

describe('two-phone demo on one venue NAT', () => {
  // Both phones share a public IP, so they share one upgrade-attempt key. The
  // concurrent-socket cap is per account, so there they are independent.
  const venue = clientKey('203.0.113.7')

  it('keys both phones identically for the upgrade limit, which must allow for it', () => {
    expect(clientKey('203.0.113.7')).toBe(venue)
  })

  it('lets two accounts on one NAT each hold a socket with a reconnect in flight', () => {
    // Worst honest case: each phone's old socket has not closed yet when its
    // reconnect opens, so four sockets are briefly live at once. Under the old
    // per-IP key those four counted against one cap; per account, two each.
    const live = new Map<string, number>()
    for (const phone of ['phone-a', 'phone-b', 'phone-a', 'phone-b']) {
      expect(openSocket(live, phone)).toBe(true)
    }
    expect(live.get(accountSocketTag('phone-a'))).toBe(2)
    expect(live.get(accountSocketTag('phone-b'))).toBe(2)
  })

  it('survives a rough demo: both phones connect, then reconnect repeatedly', () => {
    // Two initial connects, then each phone reconnects every 5s for a minute
    // (flaky venue Wi-Fi, app backgrounded, page reloads).
    const times = [0, 500]
    for (let t = 5_000; t < WINDOW_MS; t += 5_000) times.push(t, t + 250)
    const verdicts = replay(times)
    expect(times.length).toBeLessThanOrEqual(LIMIT)
    expect(verdicts.every((v) => v.allowed)).toBe(true)
  })

  it('lets a fresh demo run start right after a previous one', () => {
    // A full minute of demo reconnects, then a second pair of phones joins.
    const first = [0, 500]
    for (let t = 5_000; t < WINDOW_MS; t += 5_000) first.push(t, t + 250)
    const verdicts = replay([...first, WINDOW_MS + 1_000, WINDOW_MS + 1_500])
    expect(verdicts.every((v) => v.allowed)).toBe(true)
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

describe('anonymous upgrades have an answer of their own (#150)', () => {
  // Until #150 a signed-out upgrade never reached the limiter outside demo mode:
  // the 401 refused it first. These pin the answer that replaced it.
  it('are counted in a bucket separate from signed-in upgrades from the same address', () => {
    const key = clientKey('203.0.113.7') ?? ''
    expect(upgradeRateKey('anonymous', key)).not.toBe(upgradeRateKey('session', key))
    // The signed-in key is the one that shipped before, so no live window resets.
    expect(upgradeRateKey('session', key)).toBe(`ratelimit:pool-ws:${key}`)
  })

  it('are allowed fewer attempts than signed-in ones, as deployed', () => {
    const anon = wranglerInt('POOL_ANON_UPGRADE_LIMIT')
    const session = wranglerInt('POOL_UPGRADE_LIMIT')
    expect(anon).toBeGreaterThan(0)
    expect(anon).toBeLessThan(session)
  })

  it('so a signed-out crowd behind one NAT cannot spend the signed-in budget', () => {
    const anonLimit = wranglerInt('POOL_ANON_UPGRADE_LIMIT')
    const sessionLimit = wranglerInt('POOL_UPGRADE_LIMIT')
    const buckets = new Map<string, number[]>()
    const attempt = (bucket: 'session' | 'anonymous', now: number) => {
      const kvKey = upgradeRateKey(bucket, 'ip4:198.51.100.1')
      const limit = bucket === 'session' ? sessionLimit : anonLimit
      const verdict = slidingWindow(buckets.get(kvKey) ?? [], now, WINDOW_MS, limit)
      buckets.set(kvKey, verdict.hits)
      return verdict.allowed
    }
    // The browsing crowd exhausts its own window...
    const anonymous = Array.from({ length: anonLimit + 5 }, (_, i) => attempt('anonymous', i))
    expect(anonymous.filter(Boolean)).toHaveLength(anonLimit)
    // ...and the signed-in buyers on the same Wi-Fi still get every one of theirs.
    const signedIn = Array.from({ length: sessionLimit }, (_, i) => attempt('session', 100 + i))
    expect(signedIn.every(Boolean)).toBe(true)
  })

  it('and anonymous sockets are counted per address, not per throwaway identity', () => {
    // A caller with no demo cookie gets a fresh identity per socket, so the cap
    // has to key on the one thing it cannot rotate for free.
    expect(anonSocketTag('ip4:203.0.113.7')).toBe(anonSocketTag('ip4:203.0.113.7'))
    expect(anonSocketTag('ip4:203.0.113.7')).not.toBe(anonSocketTag('ip4:203.0.113.8'))
    expect(anonSocketTag('ip4:203.0.113.7')).not.toBe(accountSocketTag('ip4:203.0.113.7'))
    expect(wranglerInt('POOL_ANON_SOCKETS_PER_IP')).toBeGreaterThan(0)
  })
})

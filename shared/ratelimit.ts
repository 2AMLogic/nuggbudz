/**
 * Abuse limits for the pool socket, as pure decisions.
 *
 * Independent checks guard `/api/pool/ws`:
 *
 * - sliding windows on upgrade *attempts*, stored in KV and checked in the
 *   Worker, so a flood is turned away before any Durable Object runs. Since
 *   #106 a buyer — an account, or a browser's demo cookie — has a window of its
 *   own, and only anonymous upgrades are also counted per address, which is
 *   what stops a flood from one machine (see `upgradeWindows`);
 * - a cap on *concurrent* anonymous sockets per IP per shard, checked against
 *   the shard's live sockets by hibernation tag, because only the shard knows
 *   when a socket has closed (`anonSocketTag`);
 * - a cap on *concurrent* sockets per signed-in account per shard
 *   (`accountSocketTag`), keyed on the account rather than the IP because
 *   carrier NAT puts many unrelated buyers behind one address.
 *
 * The storage lives with the callers; everything here is plain data in, verdict
 * out, so the thresholds can be tested without a Workers runtime.
 */

export interface WindowVerdict {
  allowed: boolean
  /** Attempt timestamps (ms) to persist: pruned to the window, plus `now` if allowed. */
  hits: number[]
  /** Whole seconds until the oldest hit leaves the window. 0 when allowed. */
  retryAfterSeconds: number
}

/**
 * Sliding-window log: allow if fewer than `limit` attempts landed in the last
 * `windowMs`. A rejected attempt is not recorded, so a client that backs off is
 * let back in as soon as the window slides, and a flood costs a read, not a write.
 */
export function slidingWindow(
  hits: readonly number[],
  now: number,
  windowMs: number,
  limit: number,
): WindowVerdict {
  const recent = hits.filter((t) => t > now - windowMs && t <= now).sort((a, b) => a - b)
  if (recent.length < limit) {
    return { allowed: true, hits: [...recent, now], retryAfterSeconds: 0 }
  }
  // The attempt that must expire before another fits is `limit` places from the end.
  const gate = recent[recent.length - limit] ?? now
  const retryAfterSeconds = Math.max(1, Math.ceil((gate + windowMs - now) / 1000))
  return { allowed: false, hits: recent, retryAfterSeconds }
}

/** Whether another socket may open when `open` are already live for this account. */
export function underConcurrencyCap(open: number, cap: number): boolean {
  return open < cap
}

/**
 * The hibernation tag a pool socket is counted under. `userId` must be the
 * server-verified session account, never anything the client sent.
 */
export function accountSocketTag(userId: string): string {
  return `user:${userId}`
}

/**
 * Which upgrade window an attempt is counted in.
 *
 * Until #150 an unauthenticated upgrade outside demo mode never reached the
 * limiter at all — the session check refused it first, and that refusal was
 * doing double duty as the flood backstop. Opening the socket to signed-out
 * visitors took the backstop away, so the answer is written down here rather
 * than inherited: anonymous upgrades are counted in a bucket of their own
 * (`POOL_ANON_UPGRADE_LIMIT`), kept *separate* from the signed-in one so a
 * crowd browsing signed-out behind one venue NAT can never spend the budget of
 * the signed-in buyers standing next to them. Since #106 the signed-in bucket is
 * per account rather than per address, so it no longer has a room to share.
 */
export type UpgradeBucket = 'session' | 'anonymous'

/**
 * What one buyer's phone opens in its busiest honest minute (#106). Every pool
 * socket is a fresh upgrade — `usePool` never reuses one — so each entry is a
 * `connect()` call or `usePool`'s plain-HTTP probe, which is counted when
 * allowed. The receiver's handoff tab is here because #104 made it one: the
 * camera app opens the link in a new tab, and that tab opens a socket.
 */
export const BUYER_BUSIEST_MINUTE = {
  /** The landing screen's browse socket. */
  browse: 1,
  /** Turning on precise location re-opens it, for the right circle. */
  preciseLocation: 1,
  /** Taking the seat. */
  join: 1,
  /** The handoff link, opened by the camera app in a new tab. */
  handoffTab: 1,
  /** Backing out of that tab and scanning again. */
  rescan: 1,
  /** Leaving the queue browses again, and changing their mind joins again. */
  leaveAndRejoin: 2,
  /** A socket that drops before it opens: `usePool`'s probe, then the retry. */
  lostConnection: 2,
  /** A page reload. */
  reload: 1,
} as const

/**
 * The anonymous traffic one venue address carries in a minute (#106): the busiest
 * rush a single NAT is sized for on a deployment that seats demo buyers, plus the
 * signed-out crowd that only looks at the market. On a deployment that seats
 * accounts only, nobody anonymous pairs and the same figure is all browsing, so
 * the demo deployment is the one it has to fit.
 */
export const ANON_VENUE_MINUTE = {
  /** Demo pairings completed behind one address in a minute. */
  pairings: 2,
  /** Signed-out visitors arriving behind that address who only look. */
  browsers: 10,
} as const

/**
 * Upgrades one completed pairing costs: each buddy browses and then joins, and
 * the receiver's handoff tab opens a third socket (#104). A rescan or reconnect
 * is not here — it is the buyer's own budget (`BUYER_BUSIEST_MINUTE`) that
 * absorbs it, which is the point of giving a buyer one.
 */
export const UPGRADES_PER_PAIRING = 2 * (1 + 1) + 1

/**
 * Upgrades one buyer may make per window. Deployed as `POOL_UPGRADE_LIMIT`.
 *
 * The handoff tab is charged here rather than exempted. A socket that never
 * sends `join` is cheaper, but at the upgrade nothing says it is one — the
 * first message has not arrived — so an exemption would rest on the client's
 * word, and a flood would simply say the same thing.
 */
export function buyerUpgradeLimit(): number {
  return Object.values(BUYER_BUSIEST_MINUTE).reduce((sum, n) => sum + n, 0)
}

/** Anonymous upgrades one address may make per window. `POOL_ANON_UPGRADE_LIMIT`. */
export function anonAddressUpgradeLimit(): number {
  return ANON_VENUE_MINUTE.pairings * UPGRADES_PER_PAIRING + ANON_VENUE_MINUTE.browsers
}

/**
 * The most attempts a window of `windowSeconds` can actually enforce. KV accepts
 * at most one write a second to one key, and every allowed attempt is a write to
 * its window's key — so past one a second the extra writes are dropped (we fail
 * open on them), the log under-counts, and a limit above this can never trip.
 * This is why the room's figure cannot simply be raised until a venue fits.
 */
export function enforceableWindowLimit(windowSeconds: number): number {
  return windowSeconds
}

/** The KV key a buyer's own upgrades are counted under, per bucket. */
export function buyerRateKey(bucket: UpgradeBucket, buyerId: string): string {
  return bucket === 'session'
    ? `ratelimit:pool-ws-account:${buyerId}`
    : `ratelimit:pool-ws-anon-buyer:${buyerId}`
}

/** The KV key an anonymous address's upgrades are counted under. */
export function anonAddressRateKey(clientKey: string): string {
  return `ratelimit:pool-ws-anon:${clientKey}`
}

/** Who is upgrading, as far as the limiter is concerned. */
export type UpgradeCaller =
  | {
      bucket: 'session'
      /** The connecting address, from `clientKey`, or `'unknown'` without one. */
      clientKey: string
      /** The server-verified session account. Never anything the client sent. */
      buyerId: string
    }
  | {
      bucket: 'anonymous'
      clientKey: string
      /** The demo identity off this browser's cookie, or null when it sent none. */
      buyerId: string | null
    }

export interface UpgradeWindow {
  kvKey: string
  limit: number
}

/**
 * Which windows one upgrade is counted in (#106). An attempt is allowed only if
 * every window allows it, and recorded in all of them or none.
 *
 * - **Signed in:** the account's own window, and no address window at all. The
 *   per-address bucket this replaced was the whole room's budget — every phone
 *   on a venue's Wi-Fi is one address — so fifteen phones pairing in a minute
 *   were already at the ceiling, and one buyer's reconnects spent everyone's. An
 *   account costs a Google sign-in to mint, which an address does not, and
 *   `POOL_MAX_SOCKETS_PER_CELL` already bounds what one can hold open.
 * - **Anonymous:** the address window always — an anonymous identity is free to
 *   mint, so it is the address that turns away a flood from one machine — and,
 *   when the browser sent a demo cookie, that buyer's own window *first in the
 *   same decision*. A buyer over their own limit is refused before the address
 *   window is written, so one person reconnecting cannot spend the room's budget.
 *   A caller with no cookie gets no buyer window, because rotating a fresh one
 *   would buy a fresh window; they are counted by address alone.
 */
export function upgradeWindows(
  caller: UpgradeCaller,
  limits: { buyer: number; anonAddress: number },
): UpgradeWindow[] {
  const windows: UpgradeWindow[] = []
  if (caller.buyerId !== null) {
    windows.push({ kvKey: buyerRateKey(caller.bucket, caller.buyerId), limit: limits.buyer })
  }
  if (caller.bucket === 'anonymous') {
    windows.push({ kvKey: anonAddressRateKey(caller.clientKey), limit: limits.anonAddress })
  }
  return windows
}

/**
 * One answer from several windows: allowed only if all of them allow, and a
 * refusal waits for the slowest window to reopen, since a retry before then is
 * refused again by that one.
 */
export function combineVerdicts(verdicts: readonly WindowVerdict[]): {
  allowed: boolean
  retryAfterSeconds: number
} {
  const refused = verdicts.filter((v) => !v.allowed)
  if (refused.length === 0) return { allowed: true, retryAfterSeconds: 0 }
  return { allowed: false, retryAfterSeconds: Math.max(...refused.map((v) => v.retryAfterSeconds)) }
}

/**
 * The hibernation tag an anonymous socket is counted under.
 *
 * Keyed on the connecting address (`clientKey`) rather than the identity,
 * because an anonymous identity costs nothing to mint — a caller with no demo
 * cookie gets a fresh one per socket — so a per-identity cap would cap nothing.
 * It bounds how many idle sockets one address can hold open in one shard, which
 * is what every queue change then has to fan a `market` count out to.
 */
export function anonSocketTag(clientKey: string): string {
  return `anon:${clientKey}`
}

/**
 * Read a stored hit log defensively: KV contents are ours, but a malformed or
 * legacy value must degrade to "no history" rather than throw or be trusted.
 */
export function parseHits(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
}

/**
 * The key a client is limited under, derived from the connecting address.
 *
 * IPv4 is keyed per address. IPv6 is keyed per /64, because a single host is
 * routinely handed a whole /64 and could otherwise rotate through addresses
 * for free. Returns null for anything that is not an IP address.
 */
export function clientKey(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null
  const trimmed = ip.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    const octets = trimmed.split('.').map(Number)
    return octets.every((o) => o <= 255) ? `ip4:${octets.join('.')}` : null
  }
  const hextets = expandIpv6(trimmed)
  if (hextets === null) return null
  // IPv4-mapped (::ffff:a.b.c.d) is one IPv4 client, not a shared /64.
  if (hextets.slice(0, 6).join(':') === '0:0:0:0:0:ffff') {
    const [hi, lo] = hextets.slice(6).map((h) => Number.parseInt(h, 16)) as [number, number]
    return `ip4:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return `ip6:${hextets.slice(0, 4).join(':')}::/64`
}

function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return null
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): string[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const out: string[] = []
    for (const [i, g] of groups.entries()) {
      // An embedded IPv4 tail (::ffff:1.2.3.4) is two hextets' worth.
      if (i === groups.length - 1 && g.includes('.')) {
        const v4 = clientKey(g)
        if (v4 === null) return null
        const [a, b, c, d] = v4.slice(4).split('.').map(Number) as [number, number, number, number]
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16))
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(Number.parseInt(g, 16).toString(16))
    }
    return out
  }
  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (head === null || tail === null) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  return [...head, ...Array<string>(missing).fill('0'), ...tail]
}

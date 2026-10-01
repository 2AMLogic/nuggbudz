/**
 * Abuse limits for the pool socket, as pure decisions.
 *
 * Independent checks guard `/api/pool/ws`:
 *
 * - a per-IP sliding window on upgrade *attempts*, stored in KV and checked
 *   in the Worker, so a flood is turned away before any Durable Object runs.
 *   Since #150 there are two of these buckets per address, one for signed-in
 *   upgrades and a tighter one for anonymous ones (see `UpgradeBucket`);
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
 * than inherited: anonymous upgrades are counted in a bucket of their own,
 * sized tighter than the signed-in one (`POOL_ANON_UPGRADE_LIMIT`), and kept
 * *separate* from it so a crowd browsing signed-out behind one venue NAT can
 * never spend the budget of the signed-in buyers standing next to them.
 */
export type UpgradeBucket = 'session' | 'anonymous'

/** The KV key an upgrade attempt is counted under, per bucket. */
export function upgradeRateKey(bucket: UpgradeBucket, clientKey: string): string {
  return bucket === 'session'
    ? `ratelimit:pool-ws:${clientKey}`
    : `ratelimit:pool-ws-anon:${clientKey}`
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

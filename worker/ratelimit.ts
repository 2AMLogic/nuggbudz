import {
  parseHits,
  slidingWindow,
  type UpgradeBucket,
  upgradeRateKey,
  type WindowVerdict,
} from '../shared/ratelimit'
import { type Env, intVar } from './env'

// KV rejects an expirationTtl under 60 seconds.
const MIN_KV_TTL_SECONDS = 60

/** Default anonymous upgrades per window, when the var is unset. See wrangler.jsonc. */
const DEFAULT_ANON_UPGRADE_LIMIT = 20

/**
 * Check and record one upgrade attempt against the client's sliding window.
 *
 * KV is eventually consistent, so bursts spread across colos can overshoot the
 * limit slightly; this is a cost control, not a hard guarantee. For anonymous
 * sockets the hard backstop is the per-address concurrency cap in the pool
 * (`POOL_ANON_SOCKETS_PER_IP`). A KV failure fails open for the same reason: an
 * outage of the limiter must not take pairing down with it.
 *
 * `bucket` picks the window — see `UpgradeBucket` for why anonymous upgrades
 * have one of their own, tighter than the signed-in one.
 */
export async function checkUpgradeRate(
  env: Env,
  key: string,
  bucket: UpgradeBucket,
  now = Date.now(),
): Promise<WindowVerdict> {
  const windowSeconds = Math.max(1, intVar(env.POOL_UPGRADE_WINDOW_SECONDS, 60))
  const limit =
    bucket === 'session'
      ? Math.max(1, intVar(env.POOL_UPGRADE_LIMIT, 30))
      : Math.max(1, intVar(env.POOL_ANON_UPGRADE_LIMIT, DEFAULT_ANON_UPGRADE_LIMIT))
  const kvKey = upgradeRateKey(bucket, key)

  let stored: unknown = null
  try {
    stored = await env.SESSIONS.get(kvKey, 'json')
  } catch {
    stored = null
  }

  const verdict = slidingWindow(parseHits(stored), now, windowSeconds * 1000, limit)
  if (verdict.allowed) {
    try {
      await env.SESSIONS.put(kvKey, JSON.stringify(verdict.hits), {
        expirationTtl: Math.max(MIN_KV_TTL_SECONDS, windowSeconds),
      })
    } catch {
      // Includes KV's own per-key write rate limit; see the fail-open note above.
    }
  }
  return verdict
}

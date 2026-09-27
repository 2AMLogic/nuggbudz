import { parseHits, slidingWindow, type WindowVerdict } from '../shared/ratelimit'
import { type Env, intVar } from './env'

// KV rejects an expirationTtl under 60 seconds.
const MIN_KV_TTL_SECONDS = 60

/**
 * Check and record one upgrade attempt against the client's sliding window.
 *
 * KV is eventually consistent, so bursts spread across colos can overshoot the
 * limit slightly; this is a cost control, not a hard guarantee. The per-cell
 * concurrency cap in the pool is the hard backstop. A KV failure fails open for
 * the same reason: an outage of the limiter must not take pairing down with it.
 */
export async function checkUpgradeRate(
  env: Env,
  key: string,
  now = Date.now(),
): Promise<WindowVerdict> {
  const windowSeconds = Math.max(1, intVar(env.POOL_UPGRADE_WINDOW_SECONDS, 60))
  const limit = Math.max(1, intVar(env.POOL_UPGRADE_LIMIT, 30))
  const kvKey = `ratelimit:pool-ws:${key}`

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

import {
  anonAddressUpgradeLimit,
  buyerUpgradeLimit,
  combineVerdicts,
  parseHits,
  slidingWindow,
  type UpgradeCaller,
  upgradeWindows,
} from '../shared/ratelimit'
import { type Env, intVar } from './env'

// KV rejects an expirationTtl under 60 seconds.
const MIN_KV_TTL_SECONDS = 60

/**
 * Check and record one upgrade attempt against every window it is counted in —
 * see `upgradeWindows` for which those are and why.
 *
 * All windows are read before any is written, and a refused attempt is written
 * to none of them: a buyer over their own limit must not also spend the
 * address's, or one person reconnecting could still empty the room.
 *
 * KV is eventually consistent, so bursts spread across colos can overshoot the
 * limit slightly; this is a cost control, not a hard guarantee. For anonymous
 * sockets the hard backstop is the per-address concurrency cap in the pool
 * (`POOL_ANON_SOCKETS_PER_IP`). A KV failure fails open for the same reason: an
 * outage of the limiter must not take pairing down with it.
 */
export async function checkUpgradeRate(
  env: Env,
  caller: UpgradeCaller,
  now = Date.now(),
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const windowSeconds = Math.max(1, intVar(env.POOL_UPGRADE_WINDOW_SECONDS, 60))
  const windows = upgradeWindows(caller, {
    buyer: Math.max(1, intVar(env.POOL_UPGRADE_LIMIT, buyerUpgradeLimit())),
    anonAddress: Math.max(1, intVar(env.POOL_ANON_UPGRADE_LIMIT, anonAddressUpgradeLimit())),
  })

  const verdicts = await Promise.all(
    windows.map(async (window) => {
      let stored: unknown = null
      try {
        stored = await env.SESSIONS.get(window.kvKey, 'json')
      } catch {
        stored = null
      }
      return slidingWindow(parseHits(stored), now, windowSeconds * 1000, window.limit)
    }),
  )

  const verdict = combineVerdicts(verdicts)
  if (verdict.allowed) {
    await Promise.all(
      windows.map(async (window, i) => {
        try {
          await env.SESSIONS.put(window.kvKey, JSON.stringify(verdicts[i]?.hits ?? [now]), {
            expirationTtl: Math.max(MIN_KV_TTL_SECONDS, windowSeconds),
          })
        } catch {
          // Includes KV's own per-key write rate limit; see the fail-open note above.
        }
      }),
    )
  }
  return verdict
}

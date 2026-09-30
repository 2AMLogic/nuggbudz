/**
 * What the client bundle was actually built with (#149).
 *
 * `/api/health` reports the Worker's half of payments (the two secrets). The
 * publishable key is the other half and is compiled into the bundle, so the
 * Worker cannot see it: the two can disagree, and did — production ran with
 * neither, and adding only the secrets would have left a card form that cannot
 * mount. So the build stamps a `build-info.json` asset that says which half of
 * the pair it carries, and the post-deploy check compares it to `/api/health`.
 *
 * The stamp is derived by scanning the emitted bundle, not by reading the env
 * var, so it describes what shipped rather than what the builder meant. It
 * records the key's mode only, never the key.
 */

export const BUILD_INFO_FILE = 'build-info.json'

const KEY_PATTERN = /pk_(live|test)_[A-Za-z0-9]{8,}/

/** @param {string[]} sources contents of the emitted JS files */
export function detectPublishableKey(sources) {
  let found = 'none'
  for (const src of sources) {
    const m = KEY_PATTERN.exec(src)
    if (m === null) continue
    // A live key anywhere wins; a test key must not mask it.
    if (m[1] === 'live') return 'live'
    found = 'test'
  }
  return found
}

/** @param {unknown} raw parsed JSON from the deployed asset, hostile until checked */
export function parseBuildInfo(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const mode = /** @type {{ stripePublishableKey?: unknown }} */ (raw).stripePublishableKey
  if (mode !== 'live' && mode !== 'test' && mode !== 'none') return null
  return { stripePublishableKey: mode }
}

/**
 * @param {string} payments `/api/health`'s `payments`
 * @param {{ stripePublishableKey: 'live' | 'test' | 'none' } | null} info
 * @returns {{ ok: boolean, message: string }}
 */
export function assessClientKey(payments, info) {
  if (info === null) {
    return {
      ok: payments !== 'live',
      message:
        "Client build info is missing or unreadable, so the bundle's publishable key could not be confirmed. Rebuild with `pnpm run deploy` (it stamps build-info.json).",
    }
  }
  const has = info.stripePublishableKey !== 'none'
  if (payments === 'live' && !has) {
    return {
      ok: false,
      message:
        'PAYMENTS ARE LIVE BUT THE CLIENT HAS NO PUBLISHABLE KEY — the Worker will charge, but the card form cannot mount ("This build has no Stripe publishable key"). Rebuild with VITE_STRIPE_PUBLISHABLE_KEY set and redeploy.',
    }
  }
  if (payments !== 'live' && has) {
    return {
      ok: true,
      message: `Client bundle carries a ${info.stripePublishableKey} publishable key, but the Worker is not live — payments still need both secrets.`,
    }
  }
  return {
    ok: true,
    message: has
      ? `Client bundle carries a ${info.stripePublishableKey} publishable key.`
      : 'Client bundle carries no publishable key (consistent with payments not being live).',
  }
}

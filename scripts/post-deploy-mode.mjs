#!/usr/bin/env node
/**
 * Prints which pairing mode the just-deployed Worker is actually running in.
 *
 * `pnpm run deploy` (strict) and `pnpm run deploy:demo` (`--var
 * ALLOW_DEMO_PAIRING:1`) both end in `wrangler deploy`, and until #74 neither
 * said anything afterwards about which mode the result left production in — a
 * plain `pnpm run deploy` silently disabled demo pairing with no error and no
 * warning, and the only symptom was every pool socket answering 401.
 *
 * This deliberately never trusts the command line that invoked `wrangler
 * deploy` — a claim derived from local flags would have been just as
 * confident and just as wrong the day this bit (the flag was typed correctly,
 * the *script* just didn't pass it). It reads the one place that cannot lie
 * about what actually shipped: the deployed Worker's own `/api/health`.
 *
 * Usage: node scripts/post-deploy-mode.mjs
 *   DEPLOY_HEALTH_URL=https://nuggbudz.com/api/health  (default)
 */
const HEALTH_URL = process.env.DEPLOY_HEALTH_URL ?? 'https://nuggbudz.com/api/health'

async function main() {
  let health
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    health = await res.json()
  } catch (err) {
    console.error(
      `\nCould not confirm post-deploy mode from ${HEALTH_URL}: ${err instanceof Error ? err.message : String(err)}`,
    )
    console.error(
      'The deploy above may still have succeeded — this only failed to confirm which mode it left production in. Check by hand:',
    )
    console.error(`  curl ${HEALTH_URL}`)
    process.exitCode = 1
    return
  }

  const demo = health.demoPairing === true
  const banner = demo
    ? 'DEMO PAIRING IS ON  — unauthenticated sockets pair under a throwaway demo: identity.'
    : 'DEMO PAIRING IS OFF — sign-in required; this is the strict production path.'

  console.log(`\nPost-deploy mode (${HEALTH_URL}): demoPairing=${health.demoPairing}`)
  console.log(banner)
}

await main()

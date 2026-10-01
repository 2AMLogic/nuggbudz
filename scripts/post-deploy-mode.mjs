#!/usr/bin/env node
/**
 * Prints which pairing and payment modes the just-deployed Worker is actually
 * in, and whether the database behind it holds this checkout's migrations.
 *
 * `pnpm run deploy` (strict) and `pnpm run deploy:demo` (`--var
 * ALLOW_DEMO_PAIRING:1`) both end in `wrangler deploy`, and until #74 neither
 * said anything afterwards about which mode the result left production in — a
 * plain `pnpm run deploy` silently disabled demo pairing with no error and no
 * warning, and the only symptom was every pool socket answering 401 (since
 * #150, every signed-out `join` answering `sign_in_required` instead).
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
import { assessClientKey, BUILD_INFO_FILE, parseBuildInfo } from './build-info.mjs'
import { checkMigrations } from './migration-check.mjs'

const HEALTH_URL = process.env.DEPLOY_HEALTH_URL ?? 'https://nuggbudz.com/api/health'

/** The client half of payments: what the deployed bundle was built with. */
async function readBuildInfo() {
  try {
    const url = new URL(`/${BUILD_INFO_FILE}`, HEALTH_URL).href
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    // A missing asset falls through to the SPA's index.html, which is not JSON.
    return parseBuildInfo(await res.json())
  } catch {
    return null
  }
}

async function reportWorkerModes() {
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
    ? 'DEMO PAIRING IS ON  — signed-out browsers take seats under a throwaway demo: identity.'
    : 'DEMO PAIRING IS OFF — anyone can browse, a seat needs sign-in; the strict production path.'

  console.log(`\nPost-deploy mode (${HEALTH_URL}): demoPairing=${health.demoPairing}`)
  console.log(banner)

  // Same reasoning as the banner above, applied to the money: a missing Stripe
  // secret does not break loudly, it just makes every pairing attempt refuse, so
  // the deploy has to say so rather than leaving it to be discovered. Read back
  // off the deployed Worker for the same reason — a local `.dev.vars` or a
  // `wrangler secret put` that went to the wrong environment would both look
  // fine from here otherwise.
  console.log(
    `Payments: ${health.payments} (Stripe API base: ${health.stripeApiBase ?? 'unknown'})`,
  )
  // `live` says the secrets are bound, not that the charges go to Stripe. The
  // test lanes point STRIPE_API_BASE at a local fake; production must not.
  if (health.stripeApiBase === 'custom') {
    console.error(
      'STRIPE_API_BASE IS OVERRIDDEN on a deployment — charges are being sent somewhere that is not Stripe. That var is meant for the local payment-gate check only. Clear it in the Cloudflare dashboard and redeploy.',
    )
    process.exitCode = 1
  }
  switch (health.payments) {
    case 'live':
      console.log('PAYMENTS ARE LIVE — both halves of a match are charged, $0.99 retained.')
      break
    case 'uncharged':
      console.error(
        'PAYMENTS ARE OFF BY REQUEST — ALLOW_UNCHARGED_PAIRING is set on a deployment. Pairs are not charged. This var is meant for local dev and CI only.',
      )
      process.exitCode = 1
      break
    default:
      console.error(
        'PAYMENTS ARE UNCONFIGURED — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are missing, so this deployment REFUSES TO PAIR (it does not pair for free). Fix with:',
      )
      console.error('  wrangler secret put STRIPE_SECRET_KEY')
      console.error('  wrangler secret put STRIPE_WEBHOOK_SECRET')
      process.exitCode = 1
      break
  }

  // The Worker's secrets and the bundle's publishable key are set by different
  // steps and only one is visible to /api/health (#149).
  const client = assessClientKey(String(health.payments), await readBuildInfo())
  console.log(client.message)
  if (!client.ok) process.exitCode = 1
}

async function main() {
  await reportWorkerModes()
  // Independent of the readback above, and run even when that one could not
  // reach the Worker: production sat three migrations behind for an unknown
  // period precisely because nothing asked the database anything (#135). A
  // health endpoint that is down is no reason to also stop asking.
  const schema = await checkMigrations({ remote: true })
  if (schema.ok) {
    console.log(schema.message)
  } else {
    console.error(`\n${schema.message}`)
    process.exitCode = 1
  }
}

await main()

import type { NuggPool } from './pool'

export interface Env {
  ASSETS: Fetcher
  NUGG_POOL: DurableObjectNamespace<NuggPool>
  DB: D1Database
  SESSIONS: KVNamespace
  POOL_CELL_PRECISION: string
  MATCH_RADIUS_METERS: string
  /**
   * Both set with `wrangler secret put`, never in wrangler.jsonc. Optional
   * because `vite dev` and the smoke test run without them: an unconfigured
   * pool clears matches without charging, which is the only way to exercise
   * pairing locally without a Stripe account. See the README runbook.
   */
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}

/** Payments are live only when both Stripe secrets are bound. */
export function stripeConfigured(env: Env): env is Env & {
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
} {
  return (
    typeof env.STRIPE_SECRET_KEY === 'string' &&
    env.STRIPE_SECRET_KEY.length > 0 &&
    typeof env.STRIPE_WEBHOOK_SECRET === 'string' &&
    env.STRIPE_WEBHOOK_SECRET.length > 0
  )
}

/** Parse an integer Worker var, falling back when unset or malformed. */
export function intVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

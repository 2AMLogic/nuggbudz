import type { NuggPool } from './pool'

export interface Env {
  ASSETS: Fetcher
  NUGG_POOL: DurableObjectNamespace<NuggPool>
  DB: D1Database
  SESSIONS: KVNamespace
  POOL_CELL_PRECISION: string
  MATCH_RADIUS_METERS: string
  POOL_MAX_SOCKETS_PER_CELL: string
  POOL_UPGRADE_LIMIT: string
  POOL_UPGRADE_WINDOW_SECONDS: string
  /** How long a one-sided pickup confirmation waits before it is a dispute. */
  PICKUP_CONFIRM_TIMEOUT_MS?: string
  /** Silence from a queued buyer before their entry is dropped. */
  QUEUE_IDLE_SECONDS?: string
  /** How far ahead of that drop the buyer is warned. */
  QUEUE_WARN_LEAD_SECONDS?: string
  /** How long a match nobody has confirmed at all waits before it is cancelled. */
  MATCH_CONFIRM_SECONDS?: string
  /**
   * How close behind the longest-waiting buyer a rival has to be for standing to
   * decide between them. Widening it makes the preference stronger and the wait a
   * low-standing buyer can face longer; it can never make that wait unbounded.
   * See `findMatch` in `shared/matchmaker.ts`.
   */
  STANDING_TIEBREAK_SECONDS?: string
  /**
   * Google OAuth client credentials. Optional so a checkout without them still
   * boots — the auth routes answer 503 instead of the Worker failing to start.
   * The secret is only ever set with `wrangler secret put GOOGLE_CLIENT_SECRET`
   * (or `.dev.vars` locally); it must never appear in wrangler.jsonc.
   */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Overrides the OAuth callback origin when the Worker sits behind a proxy. */
  PUBLIC_ORIGIN?: string
  /**
   * Demo escape hatch: when truthy, an unauthenticated pool socket is given a
   * throwaway identity instead of a 401. Never set in `wrangler.jsonc` — it is
   * passed at deploy time so a checkout, `pnpm test` and CI all keep exercising
   * the strict authenticated path. See `shared/demo.ts`.
   */
  ALLOW_DEMO_PAIRING?: string
  /**
   * Stripe credentials. Both set with `wrangler secret put`, never in
   * wrangler.jsonc, and optional only so a checkout without them still boots.
   *
   * Optional is not the same as harmless: with either missing, `stripeConfigured`
   * is false and a match cannot be charged — so pairing is *refused* rather than
   * cleared for free. See `ALLOW_UNCHARGED_PAIRING` for the deliberate local
   * escape hatch, and the README runbook for the deploy checklist.
   */
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /**
   * Where the Stripe REST calls go. Set only by the payment-gate check, which
   * points it at a local fake so the charged path can be driven end to end
   * without a Stripe account; unset everywhere else, which means the real API.
   *
   * This is a *destination*, not a credential, and it cannot weaken a configured
   * deployment on its own — `stripeConfigured` still demands both secrets. It is
   * here for the same reason `StripeClientConfig.apiBase` exists: a payment
   * boundary that can only be exercised against the live processor is one nobody
   * exercises.
   */
  STRIPE_API_BASE?: string
  /**
   * Pair without charging anybody. Truthy only in local development and in the
   * test lanes that drive pairing end to end (`pnpm smoke`, `pnpm test:e2e`).
   *
   * Checked **in addition to** the Stripe secrets being absent, never instead of
   * them: that conjunction is the whole point. An empty production secret then
   * looks like a misconfiguration (pairing refuses, loudly) rather than like
   * intentional test mode, so no single forgotten `wrangler secret put` can turn
   * the live site into free nuggets. Never set in `wrangler.jsonc`, for the same
   * reason `ALLOW_DEMO_PAIRING` never is.
   */
  ALLOW_UNCHARGED_PAIRING?: string
  /**
   * The accounts allowed to list and resolve disputed pickups — comma- or
   * whitespace-separated `users.id` values, parsed by `shared/operators.ts`.
   *
   * An allowlist of real accounts rather than a shared bearer token, because a
   * resolution moves money and the `disputes` row records who decided; a token
   * can only ever record "whoever had the token". The identity still comes from
   * the session cookie, so this var grants nothing on its own — possessing an
   * id on this list is not the same as being able to sign in as it.
   *
   * Never set in `wrangler.jsonc`, for the same reason `ALLOW_DEMO_PAIRING`
   * never is: unset means *no* operators, and the admin routes answer as though
   * they do not exist. A checkout, `pnpm test` and CI therefore have no admin
   * surface unless a lane says otherwise.
   */
  OPERATOR_USER_IDS?: string
}

/**
 * Payments are live only when both Stripe secrets are bound.
 *
 * A type guard rather than a boolean so the two secrets are non-optional on the
 * far side of it: a caller cannot reach `createPaymentIntent` with `undefined`
 * where the key belongs.
 */
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

/**
 * Truthy spellings an operator might plausibly pass to a boolean Worker var.
 *
 * Deliberately a small allow-list rather than `Boolean(raw)`: the string
 * `"false"` is truthy in JavaScript, and a var that reads `false` while behaving
 * as true is exactly the kind of thing a money gate must not be built on.
 */
export function boolVar(raw: string | undefined): boolean {
  if (raw === undefined) return false
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    default:
      return false
  }
}

/** Parse an integer Worker var, falling back when unset or malformed. */
export function intVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

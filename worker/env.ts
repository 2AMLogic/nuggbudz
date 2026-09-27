import type { NuggPool } from './pool'

export interface Env {
  ASSETS: Fetcher
  NUGG_POOL: DurableObjectNamespace<NuggPool>
  DB: D1Database
  SESSIONS: KVNamespace
  POOL_CELL_PRECISION: string
  MATCH_RADIUS_METERS: string
  /** How long a one-sided pickup confirmation waits before it is a dispute. */
  PICKUP_CONFIRM_TIMEOUT_MS?: string
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
}

/** Parse an integer Worker var, falling back when unset or malformed. */
export function intVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

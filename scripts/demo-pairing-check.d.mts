/**
 * Type declarations for demo-pairing-check.mjs, so
 * test/demo-pairing-check.test.ts gets real types without turning on
 * `allowJs`/`checkJs` for every script in scripts/ — the same division
 * scripts/guard-comment-body-at.d.mts exists for.
 */

export interface D1Target {
  /** Whether `BASE` names the local Miniflare D1 `pnpm dev` writes to. */
  local: boolean
  /** The `wrangler d1` flag that reads the store `local` names. */
  flag: '--local' | '--remote'
  /** Same information as `local`, spelled for a log line. */
  label: 'local' | 'remote'
}

export function resolveD1Target(baseUrl: string): D1Target

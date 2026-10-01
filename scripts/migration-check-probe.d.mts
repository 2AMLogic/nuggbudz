/**
 * Types for migration-check-probe.mjs, so test/migration-check.test.ts is typed
 * without `allowJs` — the same division scripts/verdict-guard-probe.d.mts exists
 * for, and the reason the `node:` half of the probe lives in a `.mjs` at all.
 */

export interface ProbeOptions {
  /** What the stub wrangler prints — a real captured banner, in practice. */
  stdout: string
  stderr?: string
  /** The stub's exit code. wrangler's own is 0 either way, which is the point. */
  status?: number
  /** Migration filenames to place in the tree; omit for the real set, `[]` for none. */
  migrations?: string[] | null
  /** wrangler.jsonc contents; omit for this checkout's real one. */
  config?: string
}

export interface ProbeResult {
  /** The script's own exit code, as a deploy would see it. */
  status: number | null
  stdout: string
  stderr: string
  /** Every argv line the stub wrangler was handed. */
  wranglerArgv: string[]
}

export const DEAD_HEALTH_URL: string

export function realMigrationNames(): string[]
export function runMigrationCheck(options: ProbeOptions & { argv?: string[] }): ProbeResult
export function runPostDeployMode(options: ProbeOptions): ProbeResult

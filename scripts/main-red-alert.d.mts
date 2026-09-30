/**
 * Type declarations for main-red-alert.mjs, so test/main-red-alert.test.ts gets
 * real types without turning on `allowJs`/`checkJs` for every script in
 * scripts/ — the same division scripts/nul-bytes.d.mts exists for.
 */

export const ALERT_LABEL: string

export const ALERT_MARKER: string

export const ALERT_TITLE: string

/** One entry per job in the run that did not come up green. */
export interface NotGreenJob {
  job: string
  /** The `needs.<job>.result` verbatim: `failure`, `cancelled`, `skipped`, … */
  result: string
}

export function notGreenJobs(needs: unknown): NotGreenJob[]

export function failureReport(failure: {
  sha: string
  runUrl: string
  attempt?: string
  jobs: NotGreenJob[]
}): string

export function alertBody(report: string): string

export function findOpenAlert(
  issues: { number: number; body?: string | null }[],
): { number: number; body?: string | null } | null

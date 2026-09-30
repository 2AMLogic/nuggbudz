/**
 * Type declarations for main-red-alert-probe.mjs, so test/main-red-alert.test.ts
 * gets real types without turning on `allowJs`/`checkJs` for every script in
 * scripts/ — the same division scripts/verdict-guard-probe.d.mts exists for.
 */

/** One request the script made to the stub forge, in the order it made them. */
export interface RecordedRequest {
  method: string
  url: string
  authorization?: string
  /** The parsed JSON payload, or `null` for a request that carried none. */
  body: { title?: string; body?: string; labels?: string[] } | null
}

export interface AlertRun {
  /** `filed` opened a new tracking issue; `commented` added to an existing one. */
  action: 'filed' | 'commented'
  issue: number
  requests: RecordedRequest[]
}

export function runAlertAgainstStub(options?: {
  openIssues?: { number: number; body?: string | null }[]
  env?: Record<string, string>
}): Promise<AlertRun>

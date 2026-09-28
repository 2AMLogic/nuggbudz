/**
 * Type declarations for protocol-merge-probe.mjs, so test/protocol-merge.test.ts
 * gets real types without turning on `allowJs`/`checkJs` for every script in
 * scripts/ — the same division scripts/pool-fixtures.d.mts exists for, and the
 * reason the `node:` half of that probe lives in a `.mjs` at all.
 */

export const DERIVED_FILE: string

export const LITERAL_FILE: string

export interface VersionBumpBranch {
  /** Branch name, and what the conflict will be labelled with. */
  name: string
  /** The summary this branch appends — different text in the same place. */
  summary: string
}

export interface VersionBumpMergeResult {
  /** The version both branches claimed. */
  bumped: number
  /** `git merge`'s exit status. Non-zero is the property under test. */
  mergeStatus: number | null
  /** Whatever git said, for a failure message worth reading. */
  mergeOutput: string
  /** Paths left unmerged, in git's order. */
  conflictedFiles: string[]
  /** `shared/protocol.ts` as the merge left it, conflict markers and all. */
  derivedSource: string
  /** The bare-literal file as the merge left it — the positive control. */
  literalSource: string
}

export function probeVersionBumpMerge(options: {
  protocolSource: string
  version: number
  branches: readonly VersionBumpBranch[]
}): VersionBumpMergeResult

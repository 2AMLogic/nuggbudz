/** Types for migration-check.mjs, so test/migration-check.test.ts is typed without `allowJs`. */

/** Which answer wrangler gave. `unreadable` is not a pass — see Verdict. */
export interface ListVerdict {
  state: 'up_to_date' | 'behind' | 'unreadable'
  /** The unapplied migration filenames, in wrangler's order. */
  pending: string[]
  /** Why the output could not be read, when that is the state. */
  reason?: string
}

export interface Verdict {
  /** False on drift *and* on a check that could not run; both exit non-zero. */
  ok: boolean
  /** Whether the question was actually answered — "could not determine" is not "clean". */
  determined: boolean
  message: string
}

export interface MigrationTarget {
  database: string
  remote: boolean
}

export const UP_TO_DATE_BANNER: string
export const PENDING_BANNER: string

export function stripJsonComments(text: string): string
export function parseD1Config(text: string): { databaseName: string; migrationsDir: string } | null
export function parseMigrationList(stdout: string): ListVerdict
export function assessMigrations(
  list: ListVerdict,
  repoMigrations: string[],
  target: MigrationTarget,
): Verdict
export function listRepoMigrations(dir: string): string[]
export function checkMigrations(options?: { remote?: boolean }): Promise<Verdict>

#!/usr/bin/env node
/**
 * Does the deployed D1 hold every migration in this checkout? (#135)
 *
 * Production ran three migrations behind the repo for an unknown period and
 * every check we had reported healthy: `/api/health` describes the Worker, not
 * the database behind it, and `demo-check` passes against a missing table
 * because a demo pair deliberately writes no rows. Same blind spot #74 closed
 * one layer up — a check that cannot fail for the thing it is named after.
 *
 * `wrangler d1 migrations list` already answers the question and nothing called
 * it. Two things about that command shape everything below:
 *
 *  - **It exits 0 either way.** A database eight migrations behind and one
 *    fully applied both return 0 (verified against the local D1, wrangler
 *    4.142.0), so the exit code carries no signal at all and the banner line is
 *    the whole answer. There is no `--json`.
 *  - **The clean banner is vacuous on its own.** `No migrations to apply!` is
 *    also what a checkout with *no* migration files prints, so the repo side is
 *    counted independently and zero files is "could not determine", never a
 *    pass.
 *
 * Which is why the verdict has three values rather than two, and why a failure
 * to run is one of them: a check that could not run must not read like one that
 * passed. Applying anything is deliberately out of scope — this notices drift;
 * a human decides what to do about it.
 *
 * Usage: node scripts/migration-check.mjs [--local]
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The two lines wrangler answers this question with. Neither is parseable JSON. */
export const UP_TO_DATE_BANNER = 'No migrations to apply!'
export const PENDING_BANNER = 'Migrations to be applied:'

/**
 * Strips `//` and block comments from JSONC without touching string contents —
 * `wrangler.jsonc` is more comment than config, and the database name lives in
 * it rather than in a literal here so the check cannot end up asking about a
 * database this repo no longer deploys.
 *
 * @param {string} text
 */
export function stripJsonComments(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i += 1
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * The binding that says which database and which migrations directory.
 *
 * @param {string} text contents of wrangler.jsonc
 * @returns {{ databaseName: string, migrationsDir: string } | null}
 */
export function parseD1Config(text) {
  /** @type {unknown} */
  let raw
  try {
    raw = JSON.parse(stripJsonComments(text))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const list = /** @type {{ d1_databases?: unknown }} */ (raw).d1_databases
  if (!Array.isArray(list) || list.length === 0) return null
  const first = /** @type {{ database_name?: unknown, migrations_dir?: unknown }} */ (list[0])
  if (typeof first?.database_name !== 'string' || first.database_name === '') return null
  const dir = first.migrations_dir
  // wrangler's own default when the binding omits it.
  return {
    databaseName: first.database_name,
    migrationsDir: typeof dir === 'string' && dir !== '' ? dir : 'migrations',
  }
}

/**
 * @typedef {{ state: 'up_to_date' | 'behind' | 'unreadable', pending: string[], reason?: string }} ListVerdict
 */

/**
 * Reads the one line that carries the answer, and the table under it.
 *
 * Pending is checked first on purpose: if output ever carried both banners the
 * safe reading is "behind", not "clean".
 *
 * @param {string} stdout
 * @returns {ListVerdict}
 */
export function parseMigrationList(stdout) {
  if (stdout.includes(PENDING_BANNER)) {
    return { state: 'behind', pending: parsePendingNames(stdout) }
  }
  if (stdout.includes(UP_TO_DATE_BANNER)) return { state: 'up_to_date', pending: [] }
  return {
    state: 'unreadable',
    pending: [],
    reason:
      'wrangler printed neither banner — it may have changed its output, or never reached the database',
  }
}

/**
 * The unapplied names out of wrangler's box-drawn single-column table. Rows are
 * the only lines carrying `│`; the borders are drawn with other glyphs.
 *
 * @param {string} stdout
 */
function parsePendingNames(stdout) {
  const names = []
  for (const line of stdout.split('\n')) {
    if (!line.includes('│')) continue
    const first = line
      .split('│')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')[0]
    if (first === undefined || first === 'Name') continue
    names.push(first)
  }
  return names
}

/**
 * The verdict, in the shape `post-deploy-mode.mjs` reports: `determined` is
 * separate from `ok` because "could not determine" and "up to date" are
 * different answers that must not print the same way, and both failures exit
 * non-zero.
 *
 * @param {ListVerdict} list
 * @param {string[]} repoMigrations filenames in the migrations directory
 * @param {{ database: string, remote: boolean }} target what was asked
 * @returns {{ ok: boolean, determined: boolean, message: string }}
 */
export function assessMigrations(list, repoMigrations, target) {
  const scope = target.remote ? '--remote' : '--local'
  const label = `the ${target.database} D1 (${target.remote ? 'remote' : 'local'})`
  const manual = `Apply them by hand (this check never applies anything):\n  wrangler d1 migrations apply ${target.database} ${scope}`
  if (repoMigrations.length === 0) {
    return {
      ok: false,
      determined: false,
      message: `COULD NOT DETERMINE whether ${label} matches this checkout: no migration files were found in the repo, and an empty migrations directory reports "${UP_TO_DATE_BANNER}" exactly like a database that is current. This is not a pass.`,
    }
  }
  if (list.state === 'unreadable') {
    return {
      ok: false,
      determined: false,
      message: `COULD NOT DETERMINE whether ${label} matches this checkout: ${list.reason ?? 'unknown reason'}. This is not a pass — the schema may be behind. Check by hand:\n  wrangler d1 migrations list ${target.database} ${scope}`,
    }
  }
  if (list.state === 'behind') {
    const missing =
      list.pending.length > 0
        ? list.pending.map((name) => `  ${name}`).join('\n')
        : '  (wrangler named none — read its output above)'
    return {
      ok: false,
      determined: true,
      message: `SCHEMA DRIFT — ${label} is missing ${list.pending.length} of the ${repoMigrations.length} migrations in this checkout:\n${missing}\nThe Worker expects the tables these create; without them its writes fail at runtime and nothing else here notices.\n${manual}`,
    }
  }
  return {
    ok: true,
    determined: true,
    message: `Schema: all ${repoMigrations.length} migrations in this checkout are applied to ${label}.`,
  }
}

/** @param {string} dir absolute path */
export function listRepoMigrations(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
  } catch {
    return []
  }
}

/** Prefer the pinned wrangler; `pnpm run deploy` has it on PATH, a bare `node` may not. */
function wranglerBin() {
  const local = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler')
  return existsSync(local) ? local : 'wrangler'
}

/**
 * @param {{ database: string, remote?: boolean }} opts
 * @returns {Promise<{ stdout: string, error: string | null }>}
 */
async function runMigrationList({ database, remote = true }) {
  const args = ['d1', 'migrations', 'list', database, remote ? '--remote' : '--local']
  try {
    // Timed out rather than left to hang: with no usable credentials wrangler
    // can sit waiting on a login, which would stall a deploy instead of
    // reporting that the schema could not be confirmed.
    const { stdout } = await execFileAsync(wranglerBin(), args, {
      cwd: REPO_ROOT,
      timeout: 120_000,
    })
    return { stdout, error: null }
  } catch (err) {
    const detail =
      /** @type {{ stderr?: string }} */ (err)?.stderr?.trim() ||
      (err instanceof Error ? err.message : String(err))
    return { stdout: '', error: `\`wrangler ${args.join(' ')}\` failed: ${detail}` }
  }
}

/**
 * @param {{ remote?: boolean }} opts
 * @returns {Promise<{ ok: boolean, determined: boolean, message: string }>}
 */
export async function checkMigrations({ remote = true } = {}) {
  const configPath = join(REPO_ROOT, 'wrangler.jsonc')
  let config = null
  try {
    config = parseD1Config(readFileSync(configPath, 'utf8'))
  } catch {
    config = null
  }
  if (config === null) {
    // No database name means nothing to ask about, so this answer is its own:
    // assessMigrations can only speak about a named target.
    return {
      ok: false,
      determined: false,
      message: `COULD NOT DETERMINE whether the deployed D1 matches this checkout: no readable D1 binding in ${configPath}. This is not a pass.`,
    }
  }
  const target = { database: config.databaseName, remote }
  const repoMigrations = listRepoMigrations(join(REPO_ROOT, config.migrationsDir))
  if (repoMigrations.length === 0) {
    return assessMigrations({ state: 'unreadable', pending: [] }, [], target)
  }
  const { stdout, error } = await runMigrationList(target)
  /** @type {ListVerdict} */
  const list =
    error === null
      ? parseMigrationList(stdout)
      : { state: 'unreadable', pending: [], reason: error }
  return assessMigrations(list, repoMigrations, target)
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const verdict = await checkMigrations({ remote: !process.argv.includes('--local') })
  if (verdict.ok) console.log(verdict.message)
  else console.error(verdict.message)
  process.exitCode = verdict.ok ? 0 : 1
}

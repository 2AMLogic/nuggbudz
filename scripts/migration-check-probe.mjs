/**
 * Runs the deploy-time schema check for real, as a subprocess, in a throwaway
 * copy of this checkout with a stub `wrangler` standing in for Cloudflare.
 *
 * A check with a green unit test and no wiring is this repo's recurring defect
 * shape, and the whole point of #135 is that the drift was invisible to
 * everything that *did* run — so the assertions in
 * `test/migration-check.test.ts` go through the actual scripts `pnpm run deploy`
 * ends in, with the real argv, the real spawn and the real exit codes. Only the
 * network is faked: the stub records the argv it was handed, which is how the
 * database name and `--remote` are proved to arrive from `wrangler.jsonc`
 * rather than from a literal.
 *
 * The copy is what makes it deterministic. Both scripts derive their root from
 * their own location, so a temp tree gives the probe its own `wrangler.jsonc`,
 * its own `migrations/`, and its own `node_modules/.bin/wrangler` — none of
 * which depend on whether the machine running the suite happens to have a
 * local D1 lying around.
 *
 * A `.mjs` module for the same reason `scripts/verdict-guard-probe.mjs` is one:
 * this is the only half that needs `node:`, and the tests stay runtime-free.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The scripts a deploy actually runs, copied byte for byte into the probe tree. */
const COPIED_SCRIPTS = ['migration-check.mjs', 'post-deploy-mode.mjs', 'build-info.mjs']

/**
 * A health URL that fails immediately rather than hanging: port 1 refuses the
 * connection, which is the "deployment unreachable" half of post-deploy-mode.
 */
export const DEAD_HEALTH_URL = 'http://127.0.0.1:1/api/health'

/**
 * @typedef {object} ProbeOptions
 * @property {string} stdout what the stub wrangler prints
 * @property {string} [stderr] what it prints on stderr
 * @property {number} [status] its exit code
 * @property {string[] | null} [migrations] migration filenames to place in the
 *   tree; omit for this repo's real set, `[]` for none
 * @property {string} [config] wrangler.jsonc contents; omit for the real one
 */

/**
 * @typedef {object} ProbeResult
 * @property {number | null} status the script's own exit code
 * @property {string} stdout
 * @property {string} stderr
 * @property {string[]} wranglerArgv every argv line the stub was handed
 */

/**
 * @param {ProbeOptions} options
 * @param {string} entry script filename under scripts/
 * @param {string[]} argv
 * @param {Record<string, string>} [env]
 * @returns {ProbeResult}
 */
function runInProbeTree(options, entry, argv, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nuggbudz-migration-check-'))
  try {
    mkdirSync(join(root, 'scripts'))
    for (const name of COPIED_SCRIPTS) {
      copyFileSync(join(REPO_ROOT, 'scripts', name), join(root, 'scripts', name))
    }
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      options.config ?? readFileSync(join(REPO_ROOT, 'wrangler.jsonc'), 'utf8'),
    )
    mkdirSync(join(root, 'migrations'))
    const migrations = options.migrations === undefined ? realMigrationNames() : options.migrations
    for (const name of migrations) writeFileSync(join(root, 'migrations', name), '')

    const argvLog = join(root, 'wrangler-argv.txt')
    writeFileSync(argvLog, '')
    writeFileSync(join(root, 'wrangler-stdout.txt'), options.stdout)
    writeFileSync(join(root, 'wrangler-stderr.txt'), options.stderr ?? '')
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    const stub = join(root, 'node_modules', '.bin', 'wrangler')
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${argvLog}'`,
        `cat '${join(root, 'wrangler-stdout.txt')}'`,
        `cat '${join(root, 'wrangler-stderr.txt')}' >&2`,
        `exit ${options.status ?? 0}`,
        '',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)

    const run = spawnSync(process.execPath, [join(root, 'scripts', entry), ...argv], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return {
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      wranglerArgv: readFileSync(argvLog, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** This checkout's own migration filenames — the count the messages quote. */
export function realMigrationNames() {
  return readdirSync(join(REPO_ROOT, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

/**
 * `node scripts/migration-check.mjs` as an operator runs it.
 *
 * @param {ProbeOptions & { argv?: string[] }} options
 * @returns {ProbeResult}
 */
export function runMigrationCheck(options) {
  return runInProbeTree(options, 'migration-check.mjs', options.argv ?? [])
}

/**
 * `node scripts/post-deploy-mode.mjs` as `pnpm run deploy` ends in, pointed at
 * a deployment that is not answering.
 *
 * @param {ProbeOptions} options
 * @returns {ProbeResult}
 */
export function runPostDeployMode(options) {
  return runInProbeTree(options, 'post-deploy-mode.mjs', [], {
    DEPLOY_HEALTH_URL: DEAD_HEALTH_URL,
  })
}

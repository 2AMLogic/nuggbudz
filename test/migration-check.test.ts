import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import {
  assessMigrations,
  parseD1Config,
  parseMigrationList,
  stripJsonComments,
  UP_TO_DATE_BANNER,
} from '../scripts/migration-check.mjs'
import {
  realMigrationNames,
  runMigrationCheck,
  runPostDeployMode,
} from '../scripts/migration-check-probe.mjs'
// The real binding, byte for byte: the claim under test is that the check asks
// about the database *this* repo deploys, so a hand-written stand-in would prove
// nothing.
import wranglerConfig from '../wrangler.jsonc?raw'

/**
 * Production ran three migrations behind the repo and every check reported
 * healthy (#135).
 *
 * `0002_users`, `0003_sauce_prefs` and `0004_disputes` were all unapplied on the
 * live database, so sign-in, sauce preferences and dispute persistence had no
 * tables to write to — and nothing could have noticed: `/api/health` describes
 * the Worker, `demo-check` passes against a missing table because a demo pair
 * writes no rows, and `pnpm smoke` runs against a local D1 that was fully
 * migrated.
 *
 * The two fixtures below are real `wrangler d1 migrations list` output, captured
 * against a local D1 (wrangler 4.142.0) — the only database that can be put into
 * a drifted state offline — verbatim apart from the trailing spaces biome strips.
 * Three facts out of that capture are what the whole check rests on:
 *
 *  - the command exits **0** in both cases, so the exit code says nothing;
 *  - the answer is one banner line, and there is no `--json`;
 *  - the clean banner is also what an empty `migrations/` prints.
 *
 * Only the `Resource location:` lines differ under `--remote`, and nothing reads
 * them.
 */

/** A database five of eight migrations in — the production incident's shape. */
const DRIFTED_OUTPUT = `
 ⛅️ wrangler 4.142.0 (update available 4.145.0)
───────────────────────────────────────────────
Resource location: local

Use --remote if you want to access the remote instance.

Migrations to be applied:
┌──────────────────────────────┐
│ Name                         │
├──────────────────────────────┤
│ 0006_holds.sql               │
├──────────────────────────────┤
│ 0007_dispute_outstanding.sql │
├──────────────────────────────┤
│ 0008_honeypot_signals.sql    │
└──────────────────────────────┘
`

/** The same command against a database that holds everything. */
const CLEAN_OUTPUT = `
 ⛅️ wrangler 4.142.0 (update available 4.145.0)
───────────────────────────────────────────────
Resource location: local

Use --remote if you want to access the remote instance.

✅ No migrations to apply!
`

const EIGHT_MIGRATIONS = [
  '0001_init.sql',
  '0002_users.sql',
  '0003_sauce_prefs.sql',
  '0004_disputes.sql',
  '0005_reputation.sql',
  '0006_holds.sql',
  '0007_dispute_outstanding.sql',
  '0008_honeypot_signals.sql',
]

const REMOTE = { database: 'nuggbudz', remote: true }

describe('reading what wrangler answered', () => {
  it('reads the clean banner as up to date', () => {
    expect(parseMigrationList(CLEAN_OUTPUT)).toEqual({ state: 'up_to_date', pending: [] })
  })

  it('names every unapplied migration out of the table', () => {
    expect(parseMigrationList(DRIFTED_OUTPUT)).toEqual({
      state: 'behind',
      pending: ['0006_holds.sql', '0007_dispute_outstanding.sql', '0008_honeypot_signals.sql'],
    })
  })

  it('treats output it does not recognise as unreadable, never as clean', () => {
    for (const output of ['', 'Authentication error [code: 10000]', 'Resource location: remote']) {
      expect(parseMigrationList(output).state).toBe('unreadable')
    }
  })

  it('reads drift rather than clean if output ever carried both banners', () => {
    expect(parseMigrationList(`${DRIFTED_OUTPUT}\n✅ ${UP_TO_DATE_BANNER}`).state).toBe('behind')
  })
})

describe('the verdict', () => {
  it('fails on drift, naming the files and the command that applies them', () => {
    const verdict = assessMigrations(parseMigrationList(DRIFTED_OUTPUT), EIGHT_MIGRATIONS, REMOTE)
    expect(verdict.ok).toBe(false)
    expect(verdict.determined).toBe(true)
    expect(verdict.message).toContain('0006_holds.sql')
    expect(verdict.message).toContain('0008_honeypot_signals.sql')
    expect(verdict.message).toContain('wrangler d1 migrations apply nuggbudz --remote')
  })

  it('passes a clean database, quoting what it checked', () => {
    const verdict = assessMigrations(parseMigrationList(CLEAN_OUTPUT), EIGHT_MIGRATIONS, REMOTE)
    expect(verdict).toEqual({
      ok: true,
      determined: true,
      message: 'Schema: all 8 migrations in this checkout are applied to the nuggbudz D1 (remote).',
    })
  })

  // The issue's second acceptance criterion: a check that could not run must not
  // look like one that passed.
  it('reports a check that could not run as undetermined, not as a pass', () => {
    const verdict = assessMigrations(
      { state: 'unreadable', pending: [], reason: 'bad credentials' },
      EIGHT_MIGRATIONS,
      REMOTE,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.determined).toBe(false)
    expect(verdict.message).toContain('COULD NOT DETERMINE')
    expect(verdict.message).toContain('bad credentials')
  })

  // `No migrations to apply!` is also what a checkout with nothing to apply
  // prints, so the clean banner alone is not evidence of anything.
  it('refuses to call an empty migrations directory up to date', () => {
    const verdict = assessMigrations(parseMigrationList(CLEAN_OUTPUT), [], REMOTE)
    expect(verdict.ok).toBe(false)
    expect(verdict.determined).toBe(false)
    expect(verdict.message).toContain('COULD NOT DETERMINE')
  })
})

describe('which database gets asked', () => {
  it('reads the name and migrations directory off the real wrangler.jsonc', () => {
    expect(parseD1Config(wranglerConfig)).toEqual({
      databaseName: 'nuggbudz',
      migrationsDir: 'migrations',
    })
  })

  it('leaves `//` alone inside a string while stripping real comments', () => {
    const text = '{ "a": "https://example.com", // trailing\n "b": /* mid */ 1 }'
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'https://example.com', b: 1 })
  })

  it('answers nothing rather than a guess when the binding is unreadable', () => {
    expect(parseD1Config('not json')).toBeNull()
    expect(parseD1Config('{ "d1_databases": [] }')).toBeNull()
    expect(parseD1Config('{ "d1_databases": [{ "binding": "DB" }] }')).toBeNull()
  })
})

/**
 * Through the real scripts, as subprocesses, with a stub `wrangler`. The unit
 * tests above would pass just as well on a module nothing called — which is the
 * shape of defect #135 is about.
 */
describe('the check as a deploy runs it', () => {
  it('goes red on a deployment with unapplied migrations', () => {
    const run = runMigrationCheck({ stdout: DRIFTED_OUTPUT })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('SCHEMA DRIFT')
    expect(run.stderr).toContain('0006_holds.sql')
  })

  it('goes green on a deployment that holds everything', () => {
    const run = runMigrationCheck({ stdout: CLEAN_OUTPUT })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(`all ${realMigrationNames().length} migrations`)
  })

  it('asks the database named in wrangler.jsonc, on the remote instance', () => {
    const run = runMigrationCheck({ stdout: CLEAN_OUTPUT })
    expect(run.wranglerArgv).toEqual(['d1 migrations list nuggbudz --remote'])
  })

  it('asks the local instance when told to', () => {
    const run = runMigrationCheck({ stdout: CLEAN_OUTPUT, argv: ['--local'] })
    expect(run.wranglerArgv).toEqual(['d1 migrations list nuggbudz --local'])
  })

  it('fails distinctly when wrangler itself could not answer', () => {
    const run = runMigrationCheck({
      stdout: '',
      stderr: 'Authentication error [code: 10000]',
      status: 1,
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('COULD NOT DETERMINE')
    expect(run.stderr).toContain('Authentication error')
    expect(run.stderr).not.toContain('SCHEMA DRIFT')
  })

  it('does not report a pass when there are no migrations to compare', () => {
    const run = runMigrationCheck({ stdout: CLEAN_OUTPUT, migrations: [] })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('COULD NOT DETERMINE')
  })
})

describe('the deploy script that carries the check', () => {
  // Both deploy paths end in this script, which is why the check lives behind it.
  it('is what `deploy` and `deploy:demo` both end in', () => {
    expect(pkg.scripts.deploy).toContain('node scripts/post-deploy-mode.mjs')
    expect(pkg.scripts['deploy:demo']).toContain('node scripts/post-deploy-mode.mjs')
  })

  it('fails the deploy on drift', () => {
    const run = runPostDeployMode({ stdout: DRIFTED_OUTPUT })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('SCHEMA DRIFT')
  })

  // A deployment whose /api/health is unreachable is no reason to stop asking
  // the database: the two readbacks answer different questions.
  it('still reports the schema when the health readback could not run', () => {
    const run = runPostDeployMode({ stdout: CLEAN_OUTPUT })
    expect(run.stderr).toContain('Could not confirm post-deploy mode')
    expect(run.stdout).toContain('migrations in this checkout are applied')
  })
})

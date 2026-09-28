/**
 * Build the two-branch version-bump case in a throwaway git repo, and merge it.
 *
 * Issue #91: twice in one night two branches independently claimed the same
 * `PROTOCOL_VERSION` for incompatible message sets, and `git` reported no
 * conflict either time — two sides writing the *same literal* merge cleanly by
 * construction, and one integer everybody agrees on is exactly what `vitest`,
 * `tsc` and `biome` are looking for. `PROTOCOL_VERSION` is now derived from the
 * end of `PROTOCOL_HISTORY`, so a bump is an appended entry; this runs the merge
 * for real rather than asserting what it would do.
 *
 * A `.mjs` module, imported by `test/protocol-merge.test.ts`, because this is the
 * only part that needs `node:` — the same division `scripts/pool-fixtures.mjs`
 * follows, and the reason `shared/` and the tests stay runtime-free.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the real file goes in the throwaway repo, so a conflict names a real path. */
export const DERIVED_FILE = 'shared/protocol.ts'

/** The shape the changelog replaces: one hand-edited literal, and nothing else. */
export const LITERAL_FILE = 'literal-version.ts'

// A hermetic git: no user config, no system config, no `init.defaultBranch`
// surprise, and an identity of its own, so the outcome is a property of git's
// merge rather than of whoever's machine is running the suite.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Protocol Merge Probe',
  GIT_AUTHOR_EMAIL: 'probe@nuggbudz.invalid',
  GIT_COMMITTER_NAME: 'Protocol Merge Probe',
  GIT_COMMITTER_EMAIL: 'probe@nuggbudz.invalid',
}

/**
 * Append a version note to `PROTOCOL_HISTORY`, the way a bump is made.
 *
 * The insertion point is found structurally — the array's closing bracket — and
 * throwing is the right answer if it is missing: a `shared/protocol.ts` with no
 * appendable changelog has lost the guard this whole probe describes, and that
 * should be loud rather than a merge that happens to come out clean.
 */
function appendVersionNote(source, version, summary) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith('export const PROTOCOL_HISTORY'))
  if (start === -1) throw new Error('no PROTOCOL_HISTORY declaration in shared/protocol.ts')
  const end = lines.indexOf(']', start)
  if (end === -1) throw new Error('no close of the PROTOCOL_HISTORY array in shared/protocol.ts')
  const entry = [
    '  {',
    `    version: ${version},`,
    `    summary: '${summary}',`,
    '    added: [],',
    "    changed: ['welcome'],",
    '  },',
  ]
  return [...lines.slice(0, end), ...entry, ...lines.slice(end)].join('\n')
}

/**
 * Two branches off one base, each bumping the wire version for its own message
 * set, merged.
 *
 * Both files are changed on both branches, in one merge: the appended changelog
 * entry, and the bare literal it replaces. The second is the positive control —
 * without it, a conflict here could just mean this harness conflicts on anything.
 *
 * @param {object} options
 * @param {string} options.protocolSource `shared/protocol.ts`, byte for byte.
 * @param {number} options.version The version on `main` — each branch bumps past it.
 * @param {ReadonlyArray<{ name: string, summary: string }>} options.branches Exactly two.
 */
export function probeVersionBumpMerge({ protocolSource, version, branches }) {
  if (branches.length !== 2) throw new Error('a collision needs exactly two branches')
  const repo = mkdtempSync(join(tmpdir(), 'nuggbudz-protocol-merge-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  const write = (path, contents) => writeFileSync(join(repo, path), contents)
  const read = (path) => readFileSync(join(repo, path), 'utf8')
  const bumped = version + 1

  try {
    git('init', '--quiet', '-b', 'main')
    mkdirSync(join(repo, 'shared'), { recursive: true })

    // Base: the wire as it stands, in both shapes.
    write(DERIVED_FILE, protocolSource)
    write(LITERAL_FILE, `export const PROTOCOL_VERSION = ${version}\n`)
    git('add', '-A')
    git('commit', '--quiet', '-m', 'base: the wire as it stands')

    for (const { name, summary } of branches) {
      git('checkout', '--quiet', 'main')
      git('checkout', '--quiet', '-b', name)
      write(DERIVED_FILE, appendVersionNote(protocolSource, bumped, summary))
      write(LITERAL_FILE, `export const PROTOCOL_VERSION = ${bumped}\n`)
      git('commit', '--quiet', '-a', '-m', `${name}: bump the wire to ${bumped}`)
    }

    git('checkout', '--quiet', branches[0].name)
    const merge = spawnSync('git', ['merge', '--no-edit', branches[1].name], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8',
    })
    const unmerged = git('diff', '--name-only', '--diff-filter=U').trim()

    return {
      bumped,
      mergeStatus: merge.status,
      mergeOutput: `${merge.stdout ?? ''}${merge.stderr ?? ''}`,
      conflictedFiles: unmerged === '' ? [] : unmerged.split('\n'),
      derivedSource: read(DERIVED_FILE),
      literalSource: read(LITERAL_FILE),
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

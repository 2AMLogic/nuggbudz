import { describe, expect, it } from 'vitest'
// Both files are read as text on purpose: this check exists to compare what the
// tooling is actually handed, not a second copy of it kept in sync by hand.
import ciSource from '../.github/workflows/ci.yml?raw'
import workspaceSource from '../pnpm-workspace.yaml?raw'

/**
 * `pnpm-workspace.yaml` has to satisfy two pnpm majors at once, and neither of
 * them says so when it does not: pnpm 11 reads `allowBuilds` and ignores an
 * unknown `onlyBuiltDependencies`, pnpm 10 does the reverse, and a key the
 * running pnpm does not know is silently dropped rather than rejected. That is
 * #61 — CI pins pnpm 10, so `allowBuilds` alone meant the esbuild and workerd
 * postinstalls were skipped on every CI job while the file's own comment said
 * they were not. Nothing failed: pnpm 10 only *warns* about ignored build
 * scripts, and both packages happened to work without their install step.
 *
 * So the hazard is a mismatch between a version pin in one file and a key
 * spelling in another, which no type checker, linter or install exit code sees.
 * These checks read both files and fail the build instead.
 */
describe('pnpm settings', () => {
  const allowBuilds = parseAllowBuilds(workspaceSource)
  const onlyBuilt = parseOnlyBuiltDependencies(workspaceSource)
  const pinnedMajors = parsePinnedPnpmMajors(ciSource)

  it('names the packages whose install scripts must run', () => {
    // A positive control: the rest of this file compares two lists, and two
    // empty lists compare equal.
    expect(allowBuilds.length).toBeGreaterThan(0)
    expect(onlyBuilt.length).toBeGreaterThan(0)
  })

  it('spells that list the same way for both pnpm majors', () => {
    // The cost of carrying two spellings is that an added dependency can reach
    // one list and not the other, which reproduces #61 for that package alone.
    expect([...onlyBuilt].sort()).toEqual([...allowBuilds].sort())
  })

  it('carries the spelling every pnpm CI pins can read', () => {
    // Also a positive control: a CI refactor that renames the setup action
    // would otherwise leave this check asserting nothing.
    expect(pinnedMajors.length).toBeGreaterThan(0)
    for (const major of pinnedMajors) {
      // `onlyBuiltDependencies` is the pnpm 10 spelling, `allowBuilds` pnpm 11+.
      const spelling = major <= 10 ? 'onlyBuiltDependencies' : 'allowBuilds'
      expect(workspaceSource).toContain(`${spelling}:`)
    }
  })

  it('pins one pnpm major across every CI job', () => {
    // Two jobs on different majors is the same skew as #61, one file over.
    expect([...new Set(pinnedMajors)]).toHaveLength(1)
  })
})

/** The pnpm 11 spelling: a mapping of package name to a boolean. */
function parseAllowBuilds(source: string): string[] {
  return blockLines(source, 'allowBuilds').flatMap((line) => {
    const match = /^\s+([^\s:]+):\s*true\s*$/.exec(line)
    return match ? [unquote(match[1])] : []
  })
}

/** The pnpm 10 spelling: a sequence of package names. */
function parseOnlyBuiltDependencies(source: string): string[] {
  return blockLines(source, 'onlyBuiltDependencies').flatMap((line) => {
    const match = /^\s+-\s*(\S+)\s*$/.exec(line)
    return match ? [unquote(match[1])] : []
  })
}

/**
 * The indented body of a top-level key, without a YAML parser — this file is
 * small, flat and hand-written, and adding a dependency to read it would move
 * the lockfile this check is about.
 */
function blockLines(source: string, key: string): string[] {
  const lines = source.split('\n')
  const start = lines.indexOf(`${key}:`)
  if (start === -1) return []
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || !/^\s/.test(line)) break
    if (line.trimStart().startsWith('#')) continue
    body.push(line)
  }
  return body
}

/** Every pnpm major pinned on a `pnpm/action-setup` step in the workflow. */
function parsePinnedPnpmMajors(source: string): number[] {
  const lines = source.split('\n')
  const majors: number[] = []
  lines.forEach((line, index) => {
    if (!line.includes('pnpm/action-setup@')) return
    for (const next of lines.slice(index + 1, index + 6)) {
      const match = /^\s+version:\s*['"]?(\d+)/.exec(next)
      if (match) {
        majors.push(Number(match[1]))
        return
      }
    }
    // An unpinned step follows whatever `packageManager` or the runner image
    // says, which is exactly the ambiguity #61 was about.
    throw new Error(`pnpm/action-setup step at line ${index + 1} pins no version`)
  })
  return majors
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}

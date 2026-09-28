import { describe, expect, it } from 'vitest'
// Both files are read as text on purpose: this check exists to compare what the
// tooling is actually handed, not a second copy of it kept in sync by hand.
import ciSource from '../.github/workflows/ci.yml?raw'
import workspaceSource from '../pnpm-workspace.yaml?raw'

/**
 * `pnpm-workspace.yaml` has to satisfy whatever pnpm CI resolves, and pnpm does
 * not say so when it cannot: a settings key the running pnpm does not know is
 * silently dropped rather than rejected. That is #61. CI pins `version: 10`,
 * which is a *floating* major — it resolves to the newest 10.x at job time — and
 * `allowBuilds` only became readable in the 10 line at 10.26.0, so the build
 * allowlist's fate depends on where that pin happens to land. Today it lands on
 * 10.34.5, which does honour `allowBuilds`; 10.20.0 through 10.25.0 do not.
 * `onlyBuiltDependencies` is read by every 10.x (and still by 11), so declaring
 * it alongside `allowBuilds` is what pins the outcome down.
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
      // A pinned major is a floor, not a version: `version: 10` resolves to the
      // newest 10.x at job time. So a pinned 10 demands the spelling *every*
      // 10.x can read, not merely the one 10.34.5 happens to accept today.
      const spelling = major <= 10 ? 'onlyBuiltDependencies' : 'allowBuilds'
      expect(workspaceSource).toContain(`${spelling}:`)
    }
  })

  it('pins one pnpm major across every CI job', () => {
    // Two jobs on different majors is the same skew as #61, one file over.
    expect([...new Set(pinnedMajors)]).toHaveLength(1)
  })
})

/** The `allowBuilds` spelling (pnpm 10.26+ and 11): package name to a boolean. */
function parseAllowBuilds(source: string): string[] {
  return blockLines(source, 'allowBuilds').flatMap((line) => {
    const match = /^\s+([^\s:]+):\s*true\s*$/.exec(line)
    return match ? [unquote(match[1])] : []
  })
}

/** The `onlyBuiltDependencies` spelling (every 10.x, and 11): a name sequence. */
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

import { describe, expect, it } from 'vitest'
import { bodyAtVerdict } from '../scripts/guard-comment-body-at.mjs'
import {
  POST_VERDICT,
  readClaudeSettings,
  runHook,
  runPostVerdict,
} from '../scripts/verdict-guard-probe.mjs'

/**
 * The machinery that was supposed to stop `--body @-`, and did not (issue #52).
 *
 * PR #30 merged on an approving Judge verdict whose comment body was the literal
 * two characters `@-`: `gh` does not expand an `@`-prefixed body, it posts it.
 * That took the rationale *and* the `loom:verdict-sha` marker with it, so
 * `verdict-staleness-guard.sh` read `UNVERIFIABLE`, failed safe by keeping the
 * verdict, and the head moved twenty seconds later onto a tree no verdict
 * described.
 *
 * Two independent defences failed. Loom's vendored Bash guard denies `--body
 * @path` but only when the character after the `@` is path-shaped, so `@-` sailed
 * through; and `post-verdict.sh` — which does refuse it — was bypassed by a raw
 * `gh pr comment`. This suite covers both, through the real executables: a hook
 * whose logic is right and whose wiring is missing is not a guard, and this repo
 * has shipped that shape before.
 */

describe('the PreToolUse guard this repo owns', () => {
  const denied = [
    ['the incident shape', 'gh pr comment 30 --body @-'],
    ['quoted', 'gh pr comment 30 --body "@-"'],
    ['single-quoted', "gh pr comment 30 --body '@-'"],
    ['attached to the short flag', 'gh pr comment 30 -b@-'],
    ['as an = value', 'gh pr comment 30 --body=@-'],
    ['on issues too', 'gh issue comment 30 --body @-'],
    ['on the edit verb, which writes the body itself', 'gh pr edit 30 --body @-'],
    ['a bare @', 'gh pr comment 30 --body @'],
    ['a filename someone expected to expand', 'gh pr comment 30 --body @review.md'],
    ['the original #4523 path shape', 'gh pr comment 30 --body @/tmp/review-30.md'],
    ['a relative path', 'gh issue edit 52 --body @./notes/body.txt'],
    ['later in a chain', 'git push && gh pr comment 30 --body @-'],
    ['after another flag', 'gh pr comment 30 --repo owner/name --body @-'],
  ] as const

  for (const [what, command] of denied) {
    it(`denies ${what}: ${command}`, () => {
      const verdict = bodyAtVerdict(command)
      expect(verdict?.tag).toBe('gh-comment-body-literal-at')
    })
  }

  const allowed = [
    // The documented false positive the vendored guard's `@[/.~]` class exists
    // to avoid (#4577). Narrowing it out is the whole reason `@-` was missed, so
    // it has to keep passing here or this guard has traded one hole for another.
    ['an @mention with prose', 'gh pr comment 30 --body "@reviewer could you look at this?"'],
    ['a lone @mention', 'gh pr comment 30 --body "@reviewer"'],
    ['a team ping', 'gh pr comment 30 --body "@2AMLogic/reviewers"'],
    // The legitimate spellings, including the stdin one `@-` is a corruption of.
    ['--body-file with a path', 'gh pr comment 30 --body-file /tmp/review-30.md'],
    ['--body-file - (stdin)', 'cat /tmp/x | gh pr comment 30 --body-file -'],
    ['a heredoc', 'gh pr comment 30 --body "$(cat <<\'EOF\'\nLGTM\nEOF\n)"'],
    ['a variable', 'gh pr comment 30 --body "$SUMMARY"'],
    ['ordinary prose', 'gh pr comment 30 --body "Approved. The tests cover the new branch."'],
    ['an unrelated gh call', 'gh pr view 30 --json headRefOid'],
    ['a different tool entirely', 'grep -r "--body @-" .'],
    // post-verdict.sh has its own refusal for this, tested below; the Bash guard
    // must not also fire on it, or the sanctioned path becomes unusable.
    [
      'post-verdict.sh, which refuses it itself',
      './.loom/scripts/post-verdict.sh 30 approved abc1234 --body @-',
    ],
  ] as const

  for (const [what, command] of allowed) {
    it(`allows ${what}`, () => {
      expect(bodyAtVerdict(command)).toBeNull()
    })
  }

  it('denies an empty comment body, which is what a failed interpolation looks like', () => {
    expect(bodyAtVerdict('gh pr comment 30 --body ""')?.tag).toBe('gh-comment-body-empty')
    // Clearing an issue body is a real thing to want, so `edit` is left alone.
    expect(bodyAtVerdict('gh issue edit 30 --body ""')).toBeNull()
  })

  it('names the shape and the sanctioned alternative in the refusal', () => {
    const reason = bodyAtVerdict('gh pr comment 30 --body @-')?.reason ?? ''
    expect(reason).toContain('@-')
    expect(reason).toContain('--body-file')
  })
})

describe('the guard as Claude Code actually runs it', () => {
  // Everything above is a pure function. These go through the executable with
  // the real stdin envelope, because that is the part that has been wrong before.
  it('denies the incident shape over the real hook contract', () => {
    const run = runHook('gh pr comment 30 --body @-')
    expect(run.status).toBe(0)
    expect(run.denied).toBe(true)
    expect(run.reason).toContain('literal string')
  })

  it('stays silent on a legitimate call', () => {
    const run = runHook('gh pr comment 30 --body-file /tmp/review-30.md')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('')
  })

  it('ignores tool calls that are not Bash', () => {
    const run = runHook('gh pr comment 30 --body @-', { toolName: 'Read' })
    expect(run.stdout.trim()).toBe('')
  })

  it('exits 0 on malformed input rather than wedging every Bash call', () => {
    const run = runHook('')
    expect(run.status).toBe(0)
  })

  it('is wired into .claude/settings.json', () => {
    // The defect this repo keeps shipping is a correct guard nothing calls. A
    // hook that is not in settings.json never runs, and nothing else would say so.
    const commands = (readClaudeSettings().hooks?.PreToolUse ?? [])
      .filter((entry) => entry.matcher === 'Bash')
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command ?? '')
    expect(commands.some((command) => command.includes('scripts/guard-comment-body-at.mjs'))).toBe(
      true,
    )
  })
})

describe('post-verdict.sh, the sanctioned way to post a verdict', () => {
  // Loom's own suite covers this script, but its tests live under .loom/, which a
  // Loom upgrade overwrites. These assertions are this repo's: the verdict that
  // merges our PRs is only trustworthy while these refusals hold, and `pnpm test`
  // is the only lane that runs on every one of our PRs.
  const refused = [
    ['@- — the stdin spelling, and the #52 incident shape', '@-', 'does NOT read the file'],
    ['@path — the #4457 shape', '@/tmp/review-30.md', 'does NOT read the file'],
    ['an empty body', '', 'must be non-empty'],
  ] as const

  for (const [what, body, message] of refused) {
    it(`refuses ${what}`, () => {
      const run = runPostVerdict(['30', 'changes-requested', 'abc1234', '--body', body])
      expect(run.status).toBe(2)
      expect(run.output).toContain(message)
      expect(run.postedBody).toBeNull()
    })
  }

  it('still posts a real body, with the verdict-sha marker appended', () => {
    // The positive control. Without it every assertion above would pass on a
    // script that refused everything — or that was not there at all.
    const run = runPostVerdict([
      '30',
      'changes-requested',
      'abc1234',
      '--body',
      'The new branch is untested; see the third hunk.',
    ])
    expect(run.status, run.output).toBe(0)
    expect(run.postedBody).toContain('The new branch is untested; see the third hunk.')
    expect(run.postedBody).toContain(
      '<!-- loom:verdict-sha sha=abc1234 verdict=changes-requested -->',
    )
  })

  it('still reads a body off stdin, which is what @- was reaching for', () => {
    const run = runPostVerdict(['30', 'changes-requested', 'abc1234', '--body-file', '-'], {
      stdin: 'Posted the long way round.',
    })
    expect(run.status, run.output).toBe(0)
    expect(run.postedBody).toContain('Posted the long way round.')
  })

  it('is present in this checkout', () => {
    // A skipped check must never look like a passing one: if Loom is ever
    // uninstalled or this script renamed, that is a finding, not a silent pass.
    expect(POST_VERDICT).toMatch(/\.loom\/scripts\/post-verdict\.sh$/)
    expect(runPostVerdict(['--help']).status).toBe(0)
  })
})

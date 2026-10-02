/**
 * Run the two guards that were supposed to stop issue #52's `--body @-`, for
 * real, as subprocesses.
 *
 * A guard with a green unit test and no wiring is this repo's recurring defect
 * shape, and a `PreToolUse` hook is only a guard when Claude Code's own stdin
 * contract reaches it — so the assertions in `test/verdict-guard.test.ts` go
 * through the actual executables rather than a re-implementation of them.
 *
 * A `.mjs` module for the same reason `scripts/protocol-merge-probe.mjs` is one:
 * this is the only half that needs `node:`, and the tests stay runtime-free.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The hook this repo owns and wires from `.claude/settings.json`. */
export const HOOK = join(REPO_ROOT, 'scripts', 'guard-comment-body-at.mjs')

/** Loom's verdict-posting script, as installed in this checkout. */
export const POST_VERDICT = join(REPO_ROOT, '.loom', 'scripts', 'post-verdict.sh')

/**
 * Feed the hook the JSON envelope Claude Code sends for a Bash tool call.
 *
 * @param {string} command
 * @param {{ toolName?: string }} [options]
 * @returns {{ status: number | null, stdout: string, denied: boolean, reason: string }}
 */
export function runHook(command, options = {}) {
  const event = {
    tool_name: options.toolName ?? 'Bash',
    tool_input: { command },
    cwd: REPO_ROOT,
  }
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  })
  const stdout = run.stdout ?? ''
  let reason = ''
  let denied = false
  if (stdout.trim() !== '') {
    const parsed = JSON.parse(stdout)
    denied = parsed.hookSpecificOutput?.permissionDecision === 'deny'
    reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? ''
  }
  return { status: run.status, stdout, denied, reason }
}

/**
 * Run `post-verdict.sh` with a stub `gh` first on PATH, so a call that is
 * *accepted* still never reaches the forge. The stub records the body it was
 * asked to post, which is how the positive control proves the marker is
 * appended rather than merely that the script exited 0.
 *
 * @param {string[]} args
 * @param {{ stdin?: string }} [options]
 * @returns {{ status: number | null, output: string, postedBody: string | null }}
 */
export function runPostVerdict(args, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nuggbudz-post-verdict-'))
  try {
    const recorded = join(dir, 'posted-body.txt')
    const stub = join(dir, 'gh')
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env bash',
        // Handle both `pr comment` and `issue comment`. Anything else exits
        // non-zero on purpose: this suite only exercises paths that must not
        // need the forge, so an unexpected call should fail loudly rather than pass.
        'if ([ "$1" = "pr" ] || [ "$1" = "issue" ]) && [ "$2" = "comment" ]; then',
        '  body_file=""',
        '  while [ $# -gt 0 ]; do',
        '    if [ "$1" = "--body" ]; then',
        '      printf "%s" "$2" > "$STUB_RECORD"',
        '      shift 2',
        '    elif [ "$1" = "--body-file" ]; then',
        '      body_file="$2"',
        '      shift 2',
        '    else',
        '      shift',
        '    fi',
        '  done',
        '  if [ -n "$body_file" ]; then',
        '    if [ "$body_file" = "-" ]; then',
        '      cat > "$STUB_RECORD"',
        '    else',
        '      cat "$body_file" > "$STUB_RECORD"',
        '    fi',
        '  fi',
        '  echo "https://example.invalid/pull/1#issuecomment-1"',
        '  exit 0',
        'fi',
        'echo "stub gh: unhandled: $*" >&2',
        'exit 3',
        '',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)

    const run = spawnSync('bash', [POST_VERDICT, ...args], {
      input: options.stdin ?? '',
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        STUB_RECORD: recorded,
      },
    })

    let postedBody = null
    try {
      postedBody = readFileSync(recorded, 'utf8')
    } catch {
      // Nothing was posted — the expected outcome for every refusal case.
    }
    return {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
      postedBody,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `.claude/settings.json`, parsed — the wiring half of "is this guard live?". */
export function readClaudeSettings() {
  return JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'))
}

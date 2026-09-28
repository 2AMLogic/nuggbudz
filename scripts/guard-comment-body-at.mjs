/**
 * A `PreToolUse` guard for the one shape the installed guards let through:
 * a `gh` comment/edit `--body` that is a bare `@`-token.
 *
 * `gh pr comment --body @path` does not expand `@path` — it posts the literal
 * string. Loom's vendored guard already denies that, but only when the
 * character after the `@` is path-shaped (`/`, `.`, `~`), so that `@reviewer`
 * prose stays allowed. `@-`, the stdin spelling of the same mistake, is not in
 * that class and is therefore allowed: it is what destroyed the approving Judge
 * verdict on PR #30 (issue #52). Both of that verdict's comments posted as the
 * literal two characters `@-` — no rationale, and no `loom:verdict-sha` marker,
 * so `verdict-staleness-guard.sh` read `UNVERIFIABLE`, failed safe by keeping
 * the verdict, and the PR merged on a tree no verdict described.
 *
 * The discriminator here is not the character after the `@` but **whether the
 * whole body is one `@`-token**. A body of exactly `@-`, `@notes.md` or `@/tmp/x`
 * is never a comment someone meant to write; `@reviewer could you look at this`
 * is, and so is a lone `@reviewer` / `@org/team` ping, so a value that is a valid
 * GitHub handle — or that has any whitespace after the token — is left alone.
 * That keeps the documented @mention exclusion intact while closing the gap.
 *
 * This lives in `scripts/` and is wired from `.claude/settings.json` because it
 * is *this repo's*: `.loom/hooks/` and `.claude/skills/repo/hooks/` are both
 * installed copies that the next upgrade overwrites, and the guard that actually
 * runs here is neither of them — it is the machine-level Loom install under
 * `~/.local/share/loom`, which this repo cannot patch at all. CLAUDE.md carries
 * the rule; this file is the mechanism.
 *
 * Contract, same as any `PreToolUse` hook: read the tool-call JSON on stdin,
 * print a decision or nothing, and **never exit non-zero** — a guard that
 * crashes must fail open rather than wedge every Bash call.
 */

import { pathToFileURL } from 'node:url'

/** Separators that end one command in a chain and start the next. */
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n'])

/** `gh <noun> <verb>` pairs whose `--body` is posted verbatim to the forge. */
const NOUNS = new Set(['pr', 'issue'])
const VERBS = new Set(['comment', 'edit'])

/**
 * A GitHub login, or an `org/team` slug. Handles are alphanumeric with internal
 * hyphens and never contain a dot, which is what separates `@reviewer` (prose)
 * from `@notes.md` (a filename someone expected to be expanded).
 */
const MENTION = /^[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/

/**
 * Split a command line into shell-ish tokens, keeping separators as tokens of
 * their own. Quotes are consumed, so `--body "@-"` and `--body @-` both yield
 * the value `@-`; anything this cannot parse confidently (a heredoc, a nested
 * `$(...)`) simply comes out as some other token, which the caller then does not
 * match — the failure direction is always "allow".
 */
export function tokenize(command) {
  const tokens = []
  let current = ''
  let started = false
  const push = () => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && i + 1 < command.length) {
      current += command[i + 1]
      started = true
      i++
      continue
    }
    if (char === '"' || char === "'") {
      const close = command.indexOf(char, i + 1)
      if (close === -1) {
        current += command.slice(i + 1)
        started = true
        break
      }
      current += command.slice(i + 1, close)
      started = true
      i = close
      continue
    }
    if (char === '\n') {
      push()
      tokens.push('\n')
      continue
    }
    if (char === ' ' || char === '\t') {
      push()
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push()
      tokens.push(two)
      i++
      continue
    }
    if (char === ';' || char === '|' || char === '&') {
      push()
      tokens.push(char)
      continue
    }
    current += char
    started = true
  }
  push()
  return tokens
}

/** The `--body`/`-b` value in one already-split command, or `undefined`. */
function bodyValue(segment) {
  for (let i = 0; i < segment.length; i++) {
    const token = segment[i]
    // `--body-file` is the correct spelling and must keep working, including
    // `--body-file -`, so only the exact flag and its `=`/attached forms count.
    if (token === '--body' || token === '-b') return segment[i + 1]
    if (token.startsWith('--body=')) return token.slice('--body='.length)
    if (token.startsWith('-b') && token.length > 2) return token.slice(2)
  }
  return undefined
}

/**
 * Decide about one Bash command. Returns `null` to allow, or the reason and the
 * stable tag to deny with.
 */
export function bodyAtVerdict(command) {
  if (typeof command !== 'string' || !command.includes('gh')) return null

  let segment = []
  const segments = [segment]
  for (const token of tokenize(command)) {
    if (SEPARATORS.has(token)) {
      segment = []
      segments.push(segment)
    } else {
      segment.push(token)
    }
  }

  for (const tokens of segments) {
    for (let i = 0; i < tokens.length - 2; i++) {
      const command_ = tokens[i]
      if (command_ !== 'gh' && !command_.endsWith('/gh')) continue
      if (!NOUNS.has(tokens[i + 1]) || !VERBS.has(tokens[i + 2])) continue

      const verb = tokens[i + 2]
      const value = bodyValue(tokens.slice(i + 3))
      if (value === undefined) continue
      const body = value.trim()

      // An empty comment is never something anyone meant to post — it is what a
      // body that silently failed to interpolate looks like. `edit` is left
      // alone: clearing an issue body is a real, if rare, thing to want.
      if (body === '' && verb === 'comment') {
        return {
          tag: 'gh-comment-body-empty',
          reason:
            `BLOCKED: 'gh ${tokens[i + 1]} comment --body' with an empty body posts a blank ` +
            'comment. If the text came from a variable or a command substitution, it did not ' +
            'interpolate — check it, or use --body-file <path>.',
        }
      }

      if (!body.startsWith('@') || /\s/.test(body)) continue
      if (MENTION.test(body.slice(1))) continue

      return {
        tag: 'gh-comment-body-literal-at',
        reason:
          `BLOCKED: 'gh ${tokens[i + 1]} ${verb} --body ${body}' does NOT expand ${body} — it ` +
          `posts the literal string '${body}'. '@-' is the stdin spelling of that mistake and ` +
          'is what destroyed the Judge verdict on PR #30 (issue #52): an approval with no ' +
          'rationale and no loom:verdict-sha marker, which then merged unreviewed. Use ' +
          '--body-file <path> (or --body-file - to read stdin), or --body "$(cat <<\'EOF\' … EOF)".',
      }
    }
  }

  return null
}

/** The decision envelope Claude Code's PreToolUse hook schema expects. */
export function decision(verdict) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (event.tool_name !== 'Bash') return
  const verdict = bodyAtVerdict(event.tool_input?.command)
  if (verdict) process.stdout.write(`${JSON.stringify(decision(verdict))}\n`)
}

// Run only when invoked as the hook, so the test can import the pure half.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Every failure is an allow: a guard that exits non-zero breaks the tool call
  // it was meant to protect, which is strictly worse than the hole it closes.
  main().catch(() => {})
}

/**
 * Type declarations for verdict-guard-probe.mjs, so test/verdict-guard.test.ts
 * gets real types without turning on `allowJs`/`checkJs` for every script in
 * scripts/ — the same division scripts/protocol-merge-probe.d.mts exists for.
 */

export const HOOK: string

export const POST_VERDICT: string

export interface HookRun {
  /** The hook must always exit 0 — a crashing guard blocks every Bash call. */
  status: number | null
  /** Raw stdout, so an assertion can say what a malformed decision looked like. */
  stdout: string
  /** True only for a well-formed `permissionDecision: "deny"`. */
  denied: boolean
  /** What the agent would be told. */
  reason: string
}

export function runHook(command: string, options?: { toolName?: string }): HookRun

export interface PostVerdictRun {
  status: number | null
  /** stdout and stderr together — the refusals are written to stderr. */
  output: string
  /** The body the stub `gh` was asked to post, or `null` if nothing was. */
  postedBody: string | null
}

export function runPostVerdict(args: string[], options?: { stdin?: string }): PostVerdictRun

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: { matcher?: string; hooks?: { type?: string; command?: string }[] }[]
  }
}

export function readClaudeSettings(): ClaudeSettings

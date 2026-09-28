/**
 * Type declarations for guard-comment-body-at.mjs, so test/comment-body-at.test.ts
 * gets real types without turning on `allowJs`/`checkJs` for every script in
 * scripts/ — the same division scripts/protocol-merge-probe.d.mts exists for.
 */

export interface BodyAtVerdict {
  /** Stable decision tag, mirroring the one Loom's vendored guard emits. */
  tag: 'gh-comment-body-literal-at' | 'gh-comment-body-empty'
  /** What the agent is told, and why the shape is never intentional. */
  reason: string
}

export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'deny'
    permissionDecisionReason: string
  }
}

export function tokenize(command: string): string[]

/** `null` allows; anything else is a deny with that reason. */
export function bodyAtVerdict(command: unknown): BodyAtVerdict | null

export function decision(verdict: BodyAtVerdict): HookDecision

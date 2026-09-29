/**
 * Type declarations for nul-bytes.mjs, so test/no-nul-bytes.test.ts gets real
 * types without turning on `allowJs`/`checkJs` for every script in scripts/ —
 * the same division scripts/verdict-guard-probe.d.mts exists for.
 */

export const BINARY_EXTENSIONS: Set<string>

export function trackedFiles(): string[]

export function hasNulByte(data: Uint8Array): boolean

export function findNulByteOffenders(): string[]

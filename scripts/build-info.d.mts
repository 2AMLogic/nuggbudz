/** Types for build-info.mjs, so test/build-info.test.ts is typed without `allowJs`. */
export type KeyMode = 'live' | 'test' | 'none'
export interface BuildInfo {
  stripePublishableKey: KeyMode
}
export const BUILD_INFO_FILE: string
export function detectPublishableKey(sources: string[]): KeyMode
export function parseBuildInfo(raw: unknown): BuildInfo | null
export function assessClientKey(
  payments: string,
  info: BuildInfo | null,
): { ok: boolean; message: string }

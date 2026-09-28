/**
 * Type declarations for brand-palette-probe.mjs, so test/deck.test.ts gets real
 * types without turning on `allowJs`/`checkJs` for every script in scripts/ —
 * the same division scripts/verdict-guard-probe.d.mts exists for.
 */

/** Absolute path to the app's stylesheet, the source of truth. */
export const APP_STYLESHEET: string

/** Absolute path to the deck's Marp theme, the copy. */
export const DECK_THEME: string

/** `{ void: '#0c0726', … }` from the app's `@theme` block. */
export function appPalette(): Record<string, string>

/** `{ void: '#0c0726', … }` from the deck theme's `--nb-*` tokens. */
export function deckPalette(): Record<string, string>

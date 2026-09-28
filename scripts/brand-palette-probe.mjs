/**
 * Read the two places the NuggBudz palette is written down, off disk.
 *
 * The app declares it in `src/styles/globals.css`; the deck's Marp theme copies
 * it by value into `.anvil/skills/deck/templates/nuggbudz.css`, because Marp
 * cannot import the app's stylesheet. A copy is only defensible if something
 * notices when it drifts — `test/deck.test.ts` is that something, and this is
 * the half of it that needs `node:`, so the tests stay runtime-free.
 *
 * A `.mjs` module for the same reason `scripts/verdict-guard-probe.mjs` is one:
 * `node:fs` has no types in this repo (deliberately — the Worker has no
 * filesystem), and `.d.mts` gives the test real types without turning on
 * `allowJs`/`checkJs` for every script here.
 *
 * Reading off disk rather than through `import ... ?raw` is load-bearing:
 * vitest stubs CSS imports to the empty string, so a glob-based version of this
 * yields two empty palettes and every assertion built on it passes forever.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The app's stylesheet — the source of truth for every brand colour. */
export const APP_STYLESHEET = `${REPO_ROOT}src/styles/globals.css`

/** The deck's Marp theme — the copy. */
export const DECK_THEME = `${REPO_ROOT}.anvil/skills/deck/templates/nuggbudz.css`

/**
 * `--<prefix><name>: #rrggbb;` pairs, lowercased.
 *
 * @param {string} css
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
function hexTokens(css, prefix) {
  /** @type {Record<string, string>} */
  const out = {}
  const pattern = new RegExp(`--${prefix}([a-z-]+):\\s*(#[0-9a-fA-F]{6});`, 'g')
  for (const [, name, hex] of css.matchAll(pattern)) out[name] = hex.toLowerCase()
  return out
}

/**
 * The app's `@theme` block only.
 *
 * The `prefers-color-scheme: dark` override below it is the same monitor with
 * the brightness pulled down, not a second palette, so it is deliberately not
 * part of the contract the deck copies.
 *
 * @returns {Record<string, string>}
 */
export function appPalette() {
  const css = readFileSync(APP_STYLESHEET, 'utf8')
  const open = css.indexOf('@theme {')
  if (open === -1) throw new Error(`no @theme block in ${APP_STYLESHEET}`)
  const body = css.slice(open + '@theme {'.length)
  const close = body.indexOf('\n}')
  if (close === -1) throw new Error(`unterminated @theme block in ${APP_STYLESHEET}`)
  return hexTokens(body.slice(0, close), 'color-')
}

/**
 * The deck theme's `--nb-*` tokens.
 *
 * @returns {Record<string, string>}
 */
export function deckPalette() {
  return hexTokens(readFileSync(DECK_THEME, 'utf8'), 'nb-')
}

/**
 * Scan every git-tracked, non-binary file for a raw NUL byte (issue #145).
 *
 * A `.mjs` module for the same reason `scripts/verdict-guard-probe.mjs` is
 * one: this is the only half that needs `node:`, so `test/no-nul-bytes.test.ts`
 * stays plain TypeScript with no node types configured for it.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

// Extensions that are binary by construction — a NUL byte in a PDF or a PNG
// is data, not a mistake. Every other extension this repo tracks is plain text.
export const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'pdf'])

/** Every path git tracks, relative to the repo root. */
export function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.length > 0)
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

/**
 * A tracked file's own bytes are the source of truth for "is it text" — an
 * extension allowlist only decides which files this is allowed to skip.
 */
export function hasNulByte(data) {
  return data.includes(0)
}

/**
 * The relative path of every tracked, non-binary file that contains a raw
 * NUL byte — the thing that makes git classify a file as binary: undiffable,
 * unmergeable, and invisible in `gh pr diff` (issue #145).
 */
export function findNulByteOffenders() {
  const offenders = []
  for (const relativePath of trackedFiles()) {
    if (BINARY_EXTENSIONS.has(extensionOf(relativePath))) continue
    const fullPath = join(REPO_ROOT, relativePath)
    // A tracked symlink (e.g. an Anvil fixture) has no content of its own to
    // scan, and its target may not even be a file.
    if (lstatSync(fullPath).isSymbolicLink()) continue
    if (hasNulByte(readFileSync(fullPath))) offenders.push(relativePath)
  }
  return offenders
}

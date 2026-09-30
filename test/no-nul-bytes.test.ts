import { describe, expect, it } from 'vitest'
import { findNulByteOffenders, hasNulByte, trackedFiles } from '../scripts/nul-bytes.mjs'

/**
 * `test/disputes.test.ts` line 123 once had a raw NUL byte inside a string
 * literal (issue #145). Git detects a NUL in the first 8000 bytes of a blob
 * and classifies the whole file as binary: `git diff`, `git log -p` and `gh pr
 * diff` all stop showing content, and a three-way merge on that path becomes
 * all-or-nothing instead of a hunk conflict a human resolves. Nothing else in
 * this repo's toolchain — vitest, tsc, biome — would ever notice, because the
 * byte sits inside a string literal that still evaluates and still passes.
 */
describe('no tracked file hides a raw NUL byte', () => {
  it('detects a NUL byte where one is actually present', () => {
    // A positive control: without this, a `readFileSync` call that silently
    // returned nothing would still leave the real check below vacuously green.
    // `TextEncoder` rather than `Buffer`, to keep this test node-types-free.
    expect(hasNulByte(new TextEncoder().encode('hi\nthere\0'))).toBe(true)
    expect(hasNulByte(new TextEncoder().encode('hi there'))).toBe(false)
  })

  it('scans every git-tracked, non-binary path for an embedded NUL byte', () => {
    // Another positive control: an empty or wrong-cwd `git ls-files` would
    // make the assertion below pass by scanning nothing.
    expect(trackedFiles().length).toBeGreaterThan(100)

    expect(
      findNulByteOffenders(),
      'these tracked files contain a raw NUL byte, which makes git treat them as binary: ' +
        'undiffable, unmergeable, and invisible in a PR review (see issue #145). Escape it ' +
        '(`\\0` in a JS/TS string) instead of typing the byte, or add its extension to ' +
        'BINARY_EXTENSIONS in scripts/nul-bytes.mjs if it is genuinely binary.',
    ).toEqual([])
  })
})

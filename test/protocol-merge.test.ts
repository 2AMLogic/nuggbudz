import { beforeAll, describe, expect, it } from 'vitest'
// The git half lives in a .mjs, the same way scripts/pool-fixtures.mjs does, so
// nothing here needs `node:` types. Importing it dials nothing: the probe only
// touches a throwaway directory under the OS temp dir, and cleans it up.
import {
  DERIVED_FILE,
  LITERAL_FILE,
  probeVersionBumpMerge,
  type VersionBumpMergeResult,
} from '../scripts/protocol-merge-probe.mjs'
import { PROTOCOL_VERSION } from '../shared/protocol'
// The real file, byte for byte. The claim under test is about *this* artifact's
// shape, so a hand-written stand-in for it would prove nothing about the repo.
import protocolSource from '../shared/protocol.ts?raw'

/**
 * Proof that two branches cannot both bump the wire version in silence.
 *
 * Twice in one night they did (issue #91): chat and money both wrote `5`, then
 * money's merge and the radius work both wrote `6`, each pair for an incompatible
 * message set. Neither produced a conflict marker and neither could — the two
 * sides wrote the *same literal*, so a textual merge is clean by construction —
 * and `vitest`, `tsc` and `biome` all passed on the merged tree, because a single
 * integer everybody agrees on is exactly what they check for. Both were caught by
 * a person reading two diffs, which is a property of the reviewer and not of the
 * repo.
 *
 * `PROTOCOL_VERSION` is now the end of `PROTOCOL_HISTORY`, so a bump is an
 * appended entry. This constructs the two-branch case and merges it for real
 * rather than asserting that it would conflict — including the positive control,
 * in the same merge, that the literal it replaces still merges clean.
 */

/** What each branch appends — different text in the same place, which is the point. */
const CHAT_SUMMARY = 'A relay between matched buddies, on a branch that knows nothing of money.'
const MONEY_SUMMARY = 'Payment in front of the pickup code, on a branch that knows nothing of chat.'

let merged: VersionBumpMergeResult

// The 60s budget is deliberate: this runs a real two-branch `git` merge in a throwaway
// temp repo (init, commits, checkouts, merge), which is process spawning and disk I/O
// that stalls on a loaded CI box, not a slow pure function. Do not "optimise" it down.
beforeAll(() => {
  merged = probeVersionBumpMerge({
    protocolSource,
    version: PROTOCOL_VERSION,
    branches: [
      { name: 'chat', summary: CHAT_SUMMARY },
      { name: 'money', summary: MONEY_SUMMARY },
    ],
  })
}, 60_000)

describe('two branches bumping the wire version', () => {
  it('cannot merge cleanly', () => {
    expect(merged.mergeStatus, `git merge said: ${merged.mergeOutput}`).not.toBe(0)
  })

  it('conflicts in the changelog, and only there', () => {
    expect(merged.conflictedFiles).toEqual([DERIVED_FILE])
  })

  it('leaves both versions of the story for a human to reconcile', () => {
    // Not merely "a conflict": both branches' claims survive in the working tree,
    // so whoever resolves it is looking at the two incompatible wires side by
    // side — which is the information neither collision had.
    expect(merged.derivedSource).toContain('<<<<<<<')
    expect(merged.derivedSource).toContain(CHAT_SUMMARY)
    expect(merged.derivedSource).toContain(MONEY_SUMMARY)
  })

  it('would have merged clean as a literal — the shape this replaces', () => {
    // The positive control. Same base, same two branches, same intent, in the
    // same merge: a hand-edited number merges silently to the number both sides
    // typed, and nothing anywhere is any the wiser. Without this assertion, a
    // green run above could just mean the probe conflicts on anything.
    expect(merged.literalSource).toBe(`export const PROTOCOL_VERSION = ${merged.bumped}\n`)
    expect(merged.conflictedFiles).not.toContain(LITERAL_FILE)
  })
})

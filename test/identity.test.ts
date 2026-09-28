import { describe, expect, it } from 'vitest'
import { demoUserId } from '../shared/demo'
import { classifyUserId, isAccountIdShaped } from '../shared/identity'

/** Shaped exactly like `crypto.randomUUID()`, which is what mints `users.id`. */
const ACCOUNT = '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c'

describe('isAccountIdShaped', () => {
  it('accepts the canonical UUID a sign-in mints', () => {
    expect(isAccountIdShaped(ACCOUNT)).toBe(true)
    expect(isAccountIdShaped(crypto.randomUUID())).toBe(true)
  })

  it('accepts either hex case, since an id is only ever compared, never parsed', () => {
    expect(isAccountIdShaped(ACCOUNT.toUpperCase())).toBe(true)
  })

  it('rejects anything that is not that shape', () => {
    for (const raw of [
      '',
      '   ',
      '3f7b1a2c9d4e4f6a8b1c2d3e4f5a6b7c', // no dashes
      '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7', // a digit short
      `${ACCOUNT} `,
      `${ACCOUNT}${ACCOUNT}`,
      'zzzzzzzz-9d4e-4f6a-8b1c-2d3e4f5a6b7c', // right shape, not hex
      'smoke-user-robb',
    ]) {
      expect(isAccountIdShaped(raw)).toBe(false)
    }
  })

  it('rejects a non-string, which is how a missing field arrives', () => {
    for (const raw of [undefined, null, 42, {}, [ACCOUNT]]) {
      expect(isAccountIdShaped(raw)).toBe(false)
    }
  })
})

describe('classifyUserId', () => {
  it('calls a minted account id an account', () => {
    expect(classifyUserId(ACCOUNT)).toBe('account')
  })

  it('calls a minted demo id a demo', () => {
    expect(classifyUserId(demoUserId(crypto.randomUUID()))).toBe('demo')
    // Demo ids are held to the prefix and something after it, no more: passing
    // as `demo` books nothing, so there is nothing for extra strictness to guard.
    expect(classifyUserId(demoUserId('a'))).toBe('demo')
  })

  it('calls an empty id unauthentic — the hole this closes', () => {
    // `''` is not a demo id, and before this predicate existed "not a demo id"
    // was the whole test the ledger applied. See issue #55.
    expect(classifyUserId('')).toBe('unauthentic')
  })

  it('calls anything neither path could have minted unauthentic', () => {
    for (const raw of [
      ' ',
      '\n',
      '-',
      'null',
      'undefined',
      'anonymous',
      'user-robb',
      'demo', // the prefix, unprefixed
      'demo:', // the prefix and nothing to identify
      'DEMO:abc', // the prefix is case-sensitive, so this is not a demo id
      ' demo:abc', // nor is it a demo id with a space in front
      undefined,
      null,
      0,
    ]) {
      expect(classifyUserId(raw)).toBe('unauthentic')
    }
  })

  it('never calls a demo id an account, whatever it is built from', () => {
    // A demo id built out of a UUID is the production case: `demo:` wins, so a
    // stage phone can never be classified as somebody money can be booked for.
    expect(classifyUserId(demoUserId(ACCOUNT))).toBe('demo')
  })
})

import { describe, expect, it } from 'vitest'
import { demoUserId } from '../shared/demo'
import { isOperator, parseOperatorIds } from '../shared/operators'

/** Shaped as `crypto.randomUUID()` mints `users.id`, like every other account id. */
const ROBB = '3f7b1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c'
const DANA = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

describe('parseOperatorIds', () => {
  it('reads a single id', () => {
    expect(parseOperatorIds(ROBB)).toEqual([ROBB])
  })

  it('reads a list separated by commas, spaces or newlines', () => {
    for (const raw of [`${ROBB},${DANA}`, `${ROBB}, ${DANA}`, `${ROBB}\n${DANA}`]) {
      expect(parseOperatorIds(raw)).toEqual([ROBB, DANA])
    }
  })

  it('has no operators when the var is unset or empty', () => {
    // The shape a checkout, `pnpm test` and CI are all in: no operators, so the
    // admin surface answers as though it is not there.
    for (const raw of [undefined, '', '   ', ',,', '\n']) {
      expect(parseOperatorIds(raw)).toEqual([])
    }
  })

  it('drops an entry that is not an id a sign-in could have minted', () => {
    // Each of these would be an authorization bypass if it were honoured: a
    // wildcard, a name, a demo identity anyone can mint by loading a page.
    for (const bogus of ['*', 'all', 'robb', demoUserId('anyone'), 'demo:', `${ROBB}x`]) {
      expect(parseOperatorIds(bogus)).toEqual([])
      expect(parseOperatorIds(`${ROBB} ${bogus}`)).toEqual([ROBB])
    }
  })

  it('counts an id listed twice once', () => {
    expect(parseOperatorIds(`${ROBB},${ROBB}`)).toEqual([ROBB])
  })
})

describe('isOperator', () => {
  it('admits an account on the list', () => {
    expect(isOperator(ROBB, parseOperatorIds(`${ROBB},${DANA}`))).toBe(true)
  })

  it('refuses an account that is not', () => {
    expect(isOperator(DANA, parseOperatorIds(ROBB))).toBe(false)
  })

  it('refuses everybody when nobody is configured', () => {
    for (const userId of [ROBB, DANA, '', demoUserId('x')]) {
      expect(isOperator(userId, parseOperatorIds(undefined))).toBe(false)
    }
  })

  it('refuses an empty user id even against a list that contains one', () => {
    // A session always has a user id, so this is defensive — but "the allowlist
    // contains something empty" must never mean "an empty caller matches".
    expect(isOperator('', parseOperatorIds(`${ROBB},,`))).toBe(false)
  })

  it('is exact: a prefix of an operator id is not an operator', () => {
    expect(isOperator(ROBB.slice(0, -1), parseOperatorIds(ROBB))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { parseClientMessage } from '../shared/protocol'

describe('parseClientMessage', () => {
  it('accepts a well-formed join', () => {
    const raw = JSON.stringify({
      type: 'join',
      dealId: 'mcd-nuggets-20',
      lat: 37.7749,
      lng: -122.4194,
    })
    expect(parseClientMessage(raw)).toEqual({
      type: 'join',
      dealId: 'mcd-nuggets-20',
      lat: 37.7749,
      lng: -122.4194,
    })
  })

  it('accepts a join with no coordinates — the server places the socket', () => {
    // The promptless default: the buyer never turned on precise location, so the
    // client has nothing to send and the Worker's resolved fix stands.
    const raw = JSON.stringify({ type: 'join', dealId: 'mcd-nuggets-20' })
    expect(parseClientMessage(raw)).toEqual({ type: 'join', dealId: 'mcd-nuggets-20' })
  })

  it('rejects a join carrying half a coordinate', () => {
    // Optional means both or neither. One of the pair is a malformed message,
    // not a location.
    expect(parseClientMessage(JSON.stringify({ type: 'join', dealId: 'd', lat: 37 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'join', dealId: 'd', lng: -122 }))).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'join', dealId: 'd', lat: null, lng: null })),
    ).toBeNull()
  })

  it('ignores a client-supplied name — identity comes from the session', () => {
    const raw = JSON.stringify({
      type: 'join',
      name: 'Definitely Somebody Else',
      dealId: 'mcd-nuggets-20',
      lat: 0,
      lng: 0,
    })
    expect(parseClientMessage(raw)).toEqual({
      type: 'join',
      dealId: 'mcd-nuggets-20',
      lat: 0,
      lng: 0,
    })
  })

  it('carries a sauce pair through on a join', () => {
    const raw = JSON.stringify({
      type: 'join',
      dealId: 'mcd-nuggets-20',
      sauces: ['mcd-ketchup', 'mcd-hot-mustard'],
    })
    // Passed through as sent, not reordered: whether these name real sauces on
    // this deal's menu is the catalogue's question, asked in `worker/pool.ts`.
    expect(parseClientMessage(raw)).toEqual({
      type: 'join',
      dealId: 'mcd-nuggets-20',
      sauces: ['mcd-ketchup', 'mcd-hot-mustard'],
    })
  })

  it('accepts a join with no sauces — a buyer need not have picked a pair', () => {
    expect(parseClientMessage('{"type":"join","dealId":"d","sauces":null}')).toEqual({
      type: 'join',
      dealId: 'd',
    })
  })

  it('rejects a join whose sauces are not two short strings', () => {
    const bad = (sauces: unknown) =>
      parseClientMessage(JSON.stringify({ type: 'join', dealId: 'd', sauces }))
    expect(bad('mcd-ketchup')).toBeNull()
    expect(bad([])).toBeNull()
    expect(bad(['mcd-ketchup'])).toBeNull()
    expect(bad(['mcd-ketchup', 'mcd-ketchup', 'mcd-ketchup'])).toBeNull()
    expect(bad(['mcd-ketchup', 7])).toBeNull()
    expect(bad(['mcd-ketchup', ''])).toBeNull()
    expect(bad(['mcd-ketchup', 's'.repeat(65)])).toBeNull()
    expect(bad({ 0: 'mcd-ketchup', 1: 'mcd-ketchup' })).toBeNull()
  })

  it('accepts cancel and ping', () => {
    expect(parseClientMessage('{"type":"cancel"}')).toEqual({ type: 'cancel' })
    expect(parseClientMessage('{"type":"ping","at":7}')).toEqual({ type: 'ping', at: 7 })
  })

  it('accepts a confirm with a code, normalized', () => {
    expect(parseClientMessage('{"type":"confirm_pickup","code":" a2-b3 c4 "}')).toEqual({
      type: 'confirm_pickup',
      code: 'A2B3C4',
    })
  })

  it('accepts a confirm with no code — that is the orderer tapping', () => {
    expect(parseClientMessage('{"type":"confirm_pickup"}')).toEqual({
      type: 'confirm_pickup',
      code: null,
    })
    expect(parseClientMessage('{"type":"confirm_pickup","code":null}')).toEqual({
      type: 'confirm_pickup',
      code: null,
    })
    // Punctuation only is nothing, not a code the server should compare.
    expect(parseClientMessage('{"type":"confirm_pickup","code":"---"}')).toEqual({
      type: 'confirm_pickup',
      code: null,
    })
  })

  it('rejects a confirm whose code is not a short string', () => {
    expect(parseClientMessage('{"type":"confirm_pickup","code":42}')).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'confirm_pickup', code: 'A'.repeat(65) })),
    ).toBeNull()
  })

  it('rejects malformed json', () => {
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage('null')).toBeNull()
    expect(parseClientMessage('[]')).toBeNull()
  })

  it('rejects unknown message types', () => {
    expect(parseClientMessage('{"type":"drop_tables"}')).toBeNull()
  })

  it('rejects a join with a bad coordinate', () => {
    const bad = (over: Record<string, unknown>) =>
      parseClientMessage(JSON.stringify({ type: 'join', dealId: 'd', lat: 0, lng: 0, ...over }))
    expect(bad({ lat: 91 })).toBeNull()
    expect(bad({ lng: -181 })).toBeNull()
    expect(bad({ lat: 'north' })).toBeNull()
    expect(bad({ lat: Number.NaN })).toBeNull()
  })

  it('rejects a join with an unusable deal id', () => {
    const bad = (dealId: unknown) =>
      parseClientMessage(JSON.stringify({ type: 'join', dealId, lat: 0, lng: 0 }))
    expect(bad('')).toBeNull()
    expect(bad('d'.repeat(65))).toBeNull()
    expect(bad(42)).toBeNull()
    expect(bad(null)).toBeNull()
  })
})

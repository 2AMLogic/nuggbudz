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

  it('accepts cancel and ping', () => {
    expect(parseClientMessage('{"type":"cancel"}')).toEqual({ type: 'cancel' })
    expect(parseClientMessage('{"type":"ping","at":7}')).toEqual({ type: 'ping', at: 7 })
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

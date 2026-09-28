import { describe, expect, it } from 'vitest'
import { CHAT_FRAME_LIMIT } from '../shared/chat'
import {
  PROTOCOL_HISTORY,
  PROTOCOL_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  parseClientMessage,
} from '../shared/protocol'

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

  it('accepts a chat message and leaves the text alone for the server to clean', () => {
    // Raw on purpose: sanitizing here would mean the parser decides what a
    // stranger reads, and the server would have no way to distinguish "empty
    // after cleaning" from "never sent anything".
    expect(parseClientMessage('{"type":"chat","text":"  by the drinks\\n "}')).toEqual({
      type: 'chat',
      text: '  by the drinks\n ',
    })
  })

  it('ignores a matchId or sender on a chat frame — both come off the connection', () => {
    // The `join`-ignores-`name` rule, applied to the other direction: a caller
    // must not be able to address a match they are not in, or speak as somebody
    // else. Dropped rather than rejected, so a chatty client is not disconnected.
    const raw = JSON.stringify({
      type: 'chat',
      text: 'here',
      matchId: 'somebody-elses-match',
      from: 'orderer',
      name: 'Definitely Not Me',
    })
    expect(parseClientMessage(raw)).toEqual({ type: 'chat', text: 'here' })
  })

  it('rejects a chat whose text is not a string', () => {
    expect(parseClientMessage('{"type":"chat"}')).toBeNull()
    expect(parseClientMessage('{"type":"chat","text":null}')).toBeNull()
    expect(parseClientMessage('{"type":"chat","text":42}')).toBeNull()
    expect(parseClientMessage('{"type":"chat","text":["a"]}')).toBeNull()
  })

  it('rejects a chat frame too large to be worth sanitizing', () => {
    const ok = JSON.stringify({ type: 'chat', text: 'x'.repeat(CHAT_FRAME_LIMIT) })
    expect(parseClientMessage(ok)).not.toBeNull()
    const over = JSON.stringify({ type: 'chat', text: 'x'.repeat(CHAT_FRAME_LIMIT + 1) })
    expect(parseClientMessage(over)).toBeNull()
  })

  it('ignores an unknown chat-adjacent type rather than mistaking it for one', () => {
    // A newer client may send things this server has never heard of. Null means
    // the caller answers `bad_message` and the socket stays up.
    expect(parseClientMessage('{"type":"chat_typing"}')).toBeNull()
    expect(parseClientMessage('{"type":"chat_message","text":"forged"}')).toBeNull()
  })
})

describe('PROTOCOL_VERSION', () => {
  it('is bumped past the version that had no chat', () => {
    // Chat added client and server message types, so a client and server that
    // disagree about this number disagree about the message set.
    //
    // Deliberately a bound and not an equality: a bump must not be a test edit.
    expect(PROTOCOL_VERSION).toBeGreaterThan(4)
  })

  it('is the end of the changelog rather than a number of its own', () => {
    // Also not a pinned equality. The assertion is about where the number comes
    // from: appending to PROTOCOL_HISTORY is the only way to bump it, which is
    // what makes two branches bumping it a textual conflict instead of a silent
    // agreement on one integer (issue #91, demonstrated in protocol-merge.test.ts).
    expect(PROTOCOL_VERSION).toBe(PROTOCOL_HISTORY[PROTOCOL_HISTORY.length - 1].version)
  })
})

describe('PROTOCOL_HISTORY', () => {
  it('numbers every version exactly once, ascending by one from 1', () => {
    // The defect itself: two wires both called N. A merge that resolved the
    // append conflict by keeping both entries — the mistake a hurried resolution
    // makes — fails here instead of shipping two message sets under one number.
    expect(PROTOCOL_HISTORY.map((note) => note.version)).toEqual(
      PROTOCOL_HISTORY.map((_, index) => index + 1),
    )
  })

  it('says what changed in every version', () => {
    // Both collisions were only diagnosable by reconstructing this from two
    // diffs, so an entry that records a bump without saying what it was for is
    // not an entry.
    for (const note of PROTOCOL_HISTORY) {
      expect(note.summary.trim().length, `version ${note.version} summary`).toBeGreaterThan(20)
      const touched = note.added.length + note.changed.length + (note.removed?.length ?? 0)
      expect(touched, `version ${note.version} touches no message`).toBeGreaterThan(0)
    }
  })

  it('accounts for every message type on the wire, and invents none', () => {
    // The half that catches a mis-resolved conflict on the merged tree rather
    // than at merge time: replaying the changelog has to reproduce the live
    // message set exactly. A merge that dropped one side's appended entry keeps
    // that side's message types, and they turn up here unaccounted for.
    const replayed = new Set<string>()
    for (const note of PROTOCOL_HISTORY) {
      for (const type of note.added) replayed.add(type)
      for (const type of note.removed ?? []) replayed.delete(type)
    }
    expect([...replayed].sort()).toEqual([...PROTOCOL_MESSAGE_TYPES].sort())
  })

  it('introduces each message type in one version only', () => {
    const seen = new Set<string>()
    for (const note of PROTOCOL_HISTORY) {
      for (const type of note.added) {
        expect(seen.has(type), `${type} introduced twice, again in version ${note.version}`).toBe(
          false,
        )
        seen.add(type)
      }
    }
  })

  it('never reports a version changing a message that did not exist yet', () => {
    const present = new Set<string>()
    for (const note of PROTOCOL_HISTORY) {
      for (const type of note.added) present.add(type)
      for (const type of note.changed) {
        expect(present.has(type), `version ${note.version} changed absent ${type}`).toBe(true)
      }
      for (const type of note.removed ?? []) present.delete(type)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { CHAT_RATE_LIMIT, MAX_CHAT_CHARS, reviewChatText } from '../shared/chat'
import { ACTIVE_DEALS, findDeal } from '../shared/deals'
import { demoUserId } from '../shared/demo'
import { settle } from '../shared/economics'
import { DEFAULT_EXPIRY_WINDOWS } from '../shared/expiry'
import { DEFAULT_MATCH_RADIUS_METERS, distanceMeters } from '../shared/geo'
import {
  HONEYPOT_BOW_OUT_MS,
  HONEYPOT_COOLDOWN_MS,
  HONEYPOT_FAREWELL,
  HONEYPOT_LINES,
  HONEYPOT_MAX_REPLIES,
  HONEYPOT_NAMES,
  HONEYPOT_POOL_SIZE,
  HONEYPOT_SIGNALS,
  HONEYPOT_TTL_MS,
  HONEYPOT_USER_ID_PREFIX,
  honeypotLineIsSayable,
  honeypotPlacement,
  honeypotReply,
  honeypotsEnabled,
  honeypotUserId,
  isHoneypotUserId,
  mintHoneypot,
  parseHoneypotSignal,
} from '../shared/honeypot'
import { classifyUserId } from '../shared/identity'
import { isSauceOffered, saucesForMerchant } from '../shared/sauces'
import { honeypotSignalStatements } from '../worker/honeypot'
import {
  disputeStatements,
  holdStatements,
  isHoneypotMatch,
  ledgerStatements,
} from '../worker/ledger'
import poolSource from '../worker/pool.ts?raw'
import { reputationStatements } from '../worker/reputation'

const REAL = '9f1c2b3d-0000-4000-8000-000000000001'
const DECOY = honeypotUserId('1a2b3c4d-0000-4000-8000-000000000004')
const ORIGIN = { lat: 37.7749, lng: -122.4194 }

describe('honeypot identity', () => {
  it('is prefixed, so every gate downstream can see what it is', () => {
    expect(honeypotUserId('abc')).toBe(`${HONEYPOT_USER_ID_PREFIX}abc`)
    expect(isHoneypotUserId(honeypotUserId('abc'))).toBe(true)
  })

  it('is not mistaken for an account or a demo identity, or they for it', () => {
    expect(isHoneypotUserId(REAL)).toBe(false)
    expect(isHoneypotUserId(demoUserId('x'))).toBe(false)
    expect(isHoneypotUserId('')).toBe(false)
  })

  it('classifies as its own kind rather than folding into demo', () => {
    // Own kind on purpose: the two are excluded for different reasons, and
    // collapsing them would mean a decoy inherited every one of `demo`'s
    // answers by accident — including `codeAtMatchTime`, which is true for a
    // demo pair and must never be true for a decoy.
    expect(classifyUserId(DECOY)).toBe('honeypot')
    expect(classifyUserId(demoUserId('x'))).toBe('demo')
    expect(classifyUserId(REAL)).toBe('account')
  })

  it('refuses a bare prefix, which names nobody', () => {
    expect(classifyUserId(HONEYPOT_USER_ID_PREFIX)).toBe('unauthentic')
  })
})

describe('honeypotsEnabled', () => {
  it('is off unless somebody said otherwise', () => {
    // The default, and the one that matters: a charged production deployment
    // runs decoys only if an operator typed this var.
    expect(honeypotsEnabled(undefined)).toBe(false)
    expect(honeypotsEnabled('')).toBe(false)
  })

  it('reads the truthy spellings an operator might plausibly pass', () => {
    for (const raw of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(honeypotsEnabled(raw)).toBe(true)
    }
  })

  it('reads "false" and "0" as off, which `Boolean(raw)` would not', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'nope']) {
      expect(honeypotsEnabled(raw)).toBe(false)
    }
  })
})

describe('honeypotPlacement', () => {
  const RADIUS = DEFAULT_MATCH_RADIUS_METERS

  it('puts a decoy inside the market, and never on top of the buyer', () => {
    // Two dots in the same pixel read as a rendering bug, and a decoy at the rim
    // is the one always about to fall out of the circle.
    for (let i = 0; i < 500; i++) {
      const at = honeypotPlacement(ORIGIN, RADIUS, `seed-${i}`)
      const meters = distanceMeters(ORIGIN, at)
      expect(meters).toBeGreaterThan(RADIUS * 0.15)
      expect(meters).toBeLessThan(RADIUS)
    }
  })

  it('is deterministic in its seed, so a decoy stays where it was put', () => {
    expect(honeypotPlacement(ORIGIN, RADIUS, 'same')).toEqual(
      honeypotPlacement(ORIGIN, RADIUS, 'same'),
    )
    expect(honeypotPlacement(ORIGIN, RADIUS, 'a')).not.toEqual(
      honeypotPlacement(ORIGIN, RADIUS, 'b'),
    )
  })

  it('spreads decoys around the buyer rather than stacking one bearing', () => {
    const placed = Array.from({ length: 64 }, (_, i) => honeypotPlacement(ORIGIN, RADIUS, `s${i}`))
    expect(placed.some((at) => at.lat > ORIGIN.lat)).toBe(true)
    expect(placed.some((at) => at.lat < ORIGIN.lat)).toBe(true)
    expect(placed.some((at) => at.lng > ORIGIN.lng)).toBe(true)
    expect(placed.some((at) => at.lng < ORIGIN.lng)).toBe(true)
  })

  it('survives a market at extreme latitude', () => {
    // `offsetMeters` clamps cos(lat) for the same reason `snapToGrid` does.
    const polar = { lat: 89.999, lng: 12 }
    const at = honeypotPlacement(polar, RADIUS, 'north')
    expect(Number.isFinite(at.lat)).toBe(true)
    expect(Number.isFinite(at.lng)).toBe(true)
  })
})

describe('mintHoneypot', () => {
  const deal = ACTIVE_DEALS[0]
  const mint = (id: string, now = 1_700_000_000_000) =>
    mintHoneypot({
      id,
      dealId: deal.id,
      merchant: deal.merchant,
      origin: ORIGIN,
      radiusMeters: DEFAULT_MATCH_RADIUS_METERS,
      now,
    })

  it('carries a prefixed id the money gate can read', () => {
    expect(isHoneypotUserId(mint('a').userId)).toBe(true)
  })

  it('wears a name off the catalogue, never a generated handle', () => {
    for (let i = 0; i < 100; i++) {
      expect(HONEYPOT_NAMES).toContain(mint(`n-${i}`).name)
    }
  })

  it('picks two distinct sauces off this deal’s own menu', () => {
    // A Wendy's sauce on a McDonald's box is not an order anybody could place,
    // and a sauce id spelled at a call site is this repo's other recurring bug.
    for (const active of ACTIVE_DEALS) {
      const menu = saucesForMerchant(active.merchant).map((sauce) => sauce.id)
      for (let i = 0; i < 40; i++) {
        const decoy = mintHoneypot({
          id: `s-${active.id}-${i}`,
          dealId: active.id,
          merchant: active.merchant,
          origin: ORIGIN,
          radiusMeters: DEFAULT_MATCH_RADIUS_METERS,
          now: 1,
        })
        if (decoy.sauces === null) continue
        expect(menu).toContain(decoy.sauces[0])
        expect(menu).toContain(decoy.sauces[1])
        expect(decoy.sauces[0]).not.toBe(decoy.sauces[1])
        expect(isSauceOffered(decoy.sauces[0])).toBe(true)
      }
    }
  })

  it('backdates the join so a whole roster does not read as "arrived with you"', () => {
    const now = 1_700_000_000_000
    const joins = Array.from({ length: 40 }, (_, i) => mint(`b-${i}`, now).joinedAt)
    expect(new Set(joins).size).toBeGreaterThan(1)
    for (const joinedAt of joins) expect(joinedAt).toBeLessThanOrEqual(now)
  })

  it('never backdates past the queue’s own idle window', () => {
    // A decoy that looked older than the sweep's cutoff would read as an entry
    // the pool should already have dropped.
    const now = 1_700_000_000_000
    for (let i = 0; i < 200; i++) {
      expect(now - mint(`w-${i}`, now).joinedAt).toBeLessThan(DEFAULT_EXPIRY_WINDOWS.queueIdleMs)
    }
  })

  it('expires, so a market does not only ever grow', () => {
    expect(mint('e', 1_000).expiresAt).toBe(1_000 + HONEYPOT_TTL_MS)
  })

  it('is deterministic in its id', () => {
    expect(mint('same')).toEqual(mint('same'))
  })
})

describe('honeypotReply', () => {
  it('answers the first lines a buyer actually types', () => {
    expect(honeypotReply('where are you?', 0)).toContain('doors')
    expect(honeypotReply('what are you wearing', 0)).toContain('jacket')
    expect(honeypotReply('how long?', 0)).toContain('minutes')
  })

  it('answers something even when nothing was asked', () => {
    for (let turn = 0; turn < HONEYPOT_MAX_REPLIES; turn++) {
      expect(honeypotReply('hey', turn)).not.toBeNull()
    }
  })

  it('stops talking rather than looping forever', () => {
    // A conversation that could run forever is a conversation that keeps
    // somebody standing somewhere; null is what makes the pool bow the match out.
    expect(honeypotReply('hey', HONEYPOT_MAX_REPLIES)).toBeNull()
    expect(honeypotReply('hey', HONEYPOT_MAX_REPLIES + 5)).toBeNull()
  })

  it('refuses a nonsense turn rather than indexing off the end', () => {
    expect(honeypotReply('hey', -1)).toBeNull()
    expect(honeypotReply('hey', 1.5)).toBeNull()
  })

  it('is pure: same input, same answer, no clock and no randomness', () => {
    const first = Array.from({ length: 50 }, () => honeypotReply('where?', 1))
    expect(new Set(first).size).toBe(1)
  })

  it('never returns the incoming line, in whole or in part', () => {
    // The strongest thing a unit test can say about "the buyer's text is not
    // retained": it does not even come back out.
    const secret = 'cornflower battery horse 4429'
    for (let turn = 0; turn < HONEYPOT_MAX_REPLIES; turn++) {
      const reply = honeypotReply(secret, turn) ?? ''
      expect(reply).not.toContain('cornflower')
      expect(reply).not.toContain('4429')
      expect(HONEYPOT_LINES).toContain(reply)
    }
  })

  it('only ever says a line from the catalogue', () => {
    const inputs = ['', 'where', 'WEARING?', '😀😀😀', 'a'.repeat(MAX_CHAT_CHARS), 'when eta']
    for (const input of inputs) {
      for (let turn = 0; turn < HONEYPOT_MAX_REPLIES + 2; turn++) {
        const reply = honeypotReply(input, turn)
        if (reply === null) continue
        expect(HONEYPOT_LINES).toContain(reply)
      }
    }
  })
})

describe('what a decoy is allowed to say', () => {
  it('holds every canned line to the same review a buyer’s line gets', () => {
    // Enumerated from the catalogue, so a line added later that would be
    // rejected as too long or empty fails the build rather than printing
    // nothing on a buddy's screen.
    for (const line of HONEYPOT_LINES) {
      expect(honeypotLineIsSayable(line), line).toBe(true)
      expect(reviewChatText(line).ok).toBe(true)
    }
  })

  it('says out loud that it is not coming', () => {
    // The honesty line, in the one sentence a buyer actually reads. A decoy that
    // simply went quiet would walk them into the non-refunding dispute path.
    expect(HONEYPOT_FAREWELL.toLowerCase()).toMatch(/can.t make|bail|sorry/)
  })
})

describe('honeypot timings', () => {
  it('bows out long before the expiry sweep could cancel the match', () => {
    // The sweep charges the *orderer* a `late_cancel`, and the orderer of a
    // decoy match is the real buyer. Losing this race would mark somebody down
    // for the server's own decoy.
    expect(HONEYPOT_BOW_OUT_MS).toBeLessThan(DEFAULT_EXPIRY_WINDOWS.matchTimeoutMs)
  })

  it('leaves a buyer alone for far longer than it kept them', () => {
    // One phantom buddy is market seeding. A buyer paired with a second and a
    // third in a row is being kept in a queue by something that knows nobody is
    // coming.
    expect(HONEYPOT_COOLDOWN_MS).toBeGreaterThan(HONEYPOT_BOW_OUT_MS * 10)
  })

  it('stocks a market with a handful of decoys, not a crowd', () => {
    expect(HONEYPOT_POOL_SIZE).toBeGreaterThan(0)
    expect(HONEYPOT_POOL_SIZE).toBeLessThan(6)
  })
})

describe('parseHoneypotSignal', () => {
  it('narrows the catalogue rather than casting', () => {
    for (const kind of HONEYPOT_SIGNALS) expect(parseHoneypotSignal(kind)).toBe(kind)
    expect(parseHoneypotSignal('matched_a_decoy')).toBeNull()
    expect(parseHoneypotSignal(undefined)).toBeNull()
    expect(parseHoneypotSignal(7)).toBeNull()
  })

  it('records only behaviours no legitimate client produces', () => {
    // Deliberately *not* "this buyer was matched with a decoy", which is the
    // ordinary cold-start case and would drown the queue on day one.
    expect([...HONEYPOT_SIGNALS].sort()).toEqual(['chat_flood', 'code_guess'])
  })
})

describe('honeypotSignalStatements', () => {
  const signal = {
    matchId: 'match-1',
    cell: '9q8',
    honeypotUserId: DECOY,
    actorUserId: REAL,
    kind: 'chat_flood' as const,
    observedAt: 1_700_000_000_000,
  }

  it('binds one parameter per placeholder', () => {
    for (const statement of honeypotSignalStatements(signal)) {
      expect(statement.params).toHaveLength((statement.sql.match(/\?/g) ?? []).length)
    }
  })

  it('records who, which decoy, which match and when — and nothing else', () => {
    // The column list is the whole privacy argument: there is no place here for
    // what was said, so no future caller can put it there by passing one more
    // field. Nuggchat is relayed and never stored, and the tripwire watching
    // that channel is not an exception to it.
    const [row] = honeypotSignalStatements(signal)
    expect(row.params).toEqual(['match-1', '9q8', DECOY, REAL, 'chat_flood', 1_700_000_000_000])
    expect(row.sql).not.toMatch(/text|message|body|content/i)
  })

  it('files nothing for a caller whose id names nobody', () => {
    // A row naming `''` is an entry in an abuse queue a human can neither act on
    // nor rule out, which is worse than no row.
    expect(honeypotSignalStatements({ ...signal, actorUserId: '' })).toEqual([])
    expect(honeypotSignalStatements({ ...signal, actorUserId: 'not-an-id' })).toEqual([])
  })

  it('files a demo caller, because a demo deployment can still be attacked', () => {
    expect(honeypotSignalStatements({ ...signal, actorUserId: demoUserId('x') })).toHaveLength(1)
  })

  it('re-parses the kind rather than trusting it into the CHECK constraint', () => {
    expect(
      honeypotSignalStatements({
        ...signal,
        kind: 'dropped_table' as unknown as typeof signal.kind,
      }),
    ).toEqual([])
  })

  it('is rare by construction: a flood is one row, not one per message', () => {
    // `floodedAt` is a timestamp stamped on the connection and read once, at the
    // bow-out. The alternative — filing from the refusal — would file
    // `CHAT_RATE_LIMIT`-plus rows for one flood and re-introduce the storage
    // read #79 moved out of that path.
    expect(CHAT_RATE_LIMIT).toBeGreaterThan(1)
    expect(poolSource).toContain('floodedAt: now')
  })
})

describe('a decoy pairing never becomes a row anybody reads as real', () => {
  const deal = findDeal(ACTIVE_DEALS[0].id)
  if (deal === undefined) throw new Error('catalogue is empty')
  const settlement = settle(deal, 2)
  const names = { orderer: 'Robb', receiver: 'Alex' }

  for (const userIds of [
    { orderer: REAL, receiver: DECOY },
    { orderer: DECOY, receiver: REAL },
    { orderer: DECOY, receiver: DECOY },
  ]) {
    it(`books nothing for ${userIds.orderer.slice(0, 9)}/${userIds.receiver.slice(0, 9)}`, () => {
      expect(isHoneypotMatch({ userIds })).toBe(true)
      expect(
        ledgerStatements({
          matchId: 'm',
          dealId: deal.id,
          cell: '9q8',
          distanceMeters: 100,
          createdAt: 1,
          settledAt: 2,
          settlement,
          names,
          userIds,
        }),
      ).toEqual([])
      expect(
        disputeStatements({
          matchId: 'm',
          dealId: deal.id,
          cell: '9q8',
          createdAt: 1,
          disputedAt: 2,
          reason: 'timeout',
          confirmedBy: 'orderer',
          confirmedAt: 2,
          heldCents: 449,
          names,
          userIds,
        }),
      ).toEqual([])
      expect(
        holdStatements({
          matchId: 'm',
          dealId: deal.id,
          cell: '9q8',
          createdAt: 1,
          retiredAt: 2,
          reason: 'buddy_left',
          heldCents: 449,
          names,
          userIds,
        }),
      ).toEqual([])
    })
  }

  it('and the decoy itself earns no reputation counter', () => {
    // `reputationStatements` books only accounts, so a decoy is dropped before
    // the foreign key would refuse it. The *real* buyer's side of this is in
    // `worker/pool.ts` and is asserted below.
    expect(reputationStatements([{ userId: DECOY, event: 'completed' }], 1)).toEqual([])
    expect(reputationStatements([{ userId: DECOY, event: 'no_show' }], 1)).toEqual([])
  })

  it('still books a pairing of two real buyers, so the gate is not vacuous', () => {
    expect(
      ledgerStatements({
        matchId: 'm',
        dealId: deal.id,
        cell: '9q8',
        distanceMeters: 100,
        createdAt: 1,
        settledAt: 2,
        settlement,
        names,
        userIds: { orderer: REAL, receiver: '9f1c2b3d-0000-4000-8000-000000000002' },
      }).length,
    ).toBeGreaterThan(0)
  })
})

/**
 * The half of this a pure function cannot see (`worker/pool.ts`).
 *
 * Every property here is a *reachability* or an *ordering*, and this repo's
 * recurring defect is a correct predicate with a green unit test and no caller —
 * the late-refund branch, the pruned `Map` keyed by the wrong string, the QR
 * decoder wired to nothing. So the decisions are unit-tested above and the
 * structure that keeps them reachable is asserted here.
 */
describe('the honeypot path stays wired in worker/pool.ts', () => {
  const bodyOf = (signature: string): string => {
    const from = poolSource.indexOf(signature)
    expect(from, `${signature} not found`).toBeGreaterThan(-1)
    const rest = poolSource.slice(from)
    return rest.slice(0, rest.indexOf('\n  }\n'))
  }

  it('never opens a charge for a decoy pairing, on the one path that talks to Stripe', () => {
    const body = bodyOf('private async startPayments(')
    expect(body).toContain("disposition === 'honeypot'")
    // Before `this.stripe` is read, not after.
    expect(body.indexOf("disposition === 'honeypot'")).toBeLessThan(body.indexOf('this.stripe'))
  })

  it('asserts the money gate at the pairing itself rather than assuming it', () => {
    const body = bodyOf('private async matchHoneypot(')
    expect(body).toContain('this.dispositionFor(')
    expect(body).toContain("disposition !== 'honeypot'")
    // And no code on the wire, whatever `codeAtMatchTime` might one day say.
    expect(body).toContain('pickupCode: null')
  })

  it('bows out through the refunding teardown, never through a dispute', () => {
    const body = bodyOf('private async bowOutHoneypot(')
    expect(body).toContain("type: 'buddy_left'")
    expect(body).toContain("this.retireMatch(record.matchId, retired, 'buddy_left')")
    expect(body).not.toContain('disputeMatch')
    expect(body).not.toContain("'disputed'")
  })

  it('and books no standing against the real buyer it stood up', () => {
    const body = bodyOf('private async bowOutHoneypot(')
    // The call, not the word: the comment beside it explains why there is none.
    expect(body).not.toContain('this.recordStanding(')
    // The two teardowns a decoy match could otherwise fall into both name it.
    expect(bodyOf('private async cancelMatch(')).toContain("record.disposition !== 'honeypot'")
    expect(bodyOf('private async handleDisconnect(')).toContain(
      "record?.disposition !== 'honeypot'",
    )
  })

  it('is reached from the alarm, not merely defined', () => {
    const alarm = bodyOf('override async alarm(')
    expect(alarm).toContain('this.bowOutHoneypot(record, now)')
    expect(alarm).toContain('HONEYPOT_BOW_OUT_MS')
    // Ahead of both sweeps: the expiry sweep would cancel the match and charge
    // the real buyer for it.
    expect(alarm.indexOf('bowOutHoneypot')).toBeLessThan(alarm.indexOf('disputeMatch'))
    expect(alarm.indexOf('bowOutHoneypot')).toBeLessThan(alarm.indexOf('sweepExpired'))
  })

  it('arms an alarm for that bow-out, so it is a deadline and not a hope', () => {
    const body = bodyOf('private async scheduleSweep(')
    expect(body).toContain("record.disposition === 'honeypot'")
    expect(body).toContain('HONEYPOT_BOW_OUT_MS')
  })

  it('answers a confirm attempt by bowing out rather than by a misleading error', () => {
    const body = bodyOf('private async handleConfirmPickup(')
    expect(body).toContain("record.disposition === 'honeypot'")
    expect(body).toContain('this.bowOutHoneypot(record, at)')
    // Ahead of the payment gate, whose refusal would tell a buyer to wait for a
    // charge that is never going to happen.
    expect(body.indexOf("record.disposition === 'honeypot'")).toBeLessThan(
      body.indexOf('pickupUnlocked(record)'),
    )
    // And the tripwire: a code on a match that never released one.
    expect(body).toContain("'code_guess'")
  })

  it('answers chat in memory and writes nothing but a counter', () => {
    const body = bodyOf('private async replyAsHoneypot(')
    expect(body).toContain('honeypotReply(text, turn)')
    // The only thing persisted is the turn count. No text reaches storage —
    // which is what keeps `pnpm smoke`'s never-stored scan true for a decoy
    // conversation exactly as it is for a real one.
    const writes = body.match(/storage\.put<MatchRecord>\([^)]*\)/g) ?? []
    expect(writes).toHaveLength(1)
    expect(body).toContain('honeypotTurns: turn + 1')
    expect(body).not.toContain('this.env.DB')
  })

  it('reaches that reply from the live chat handler', () => {
    const body = bodyOf('private async handleChat(')
    expect(body).toContain('this.replyAsHoneypot(ws, state, record, reviewed.text, now)')
  })

  it('composes that reply offline — no model, no fetch, no third party', () => {
    // The decision the issue asked be made deliberately. A model would make the
    // sentence under the chat box ("nowhere else — not to the ledger, not to
    // us") false, and would need that sentence changed first.
    const body = bodyOf('private async replyAsHoneypot(')
    expect(body).not.toMatch(/fetch\(|await\s+ai\.|\.run\(/i)
  })

  it('counts decoys on the map exactly as it counts them in the queue', () => {
    // Indistinguishable from a real waiting buyer *on the map* is the whole
    // cold-start job; a count that excluded them would contradict the dots drawn
    // from the same set.
    const body = bodyOf('private sendWaiting(')
    expect(body).toContain('decoysEligible.length')
    expect(body).toContain('...decoysNear')
    // Through the same quantizer as everybody else, so a decoy's position is no
    // more precise on the wire than a person's.
    expect(body).toContain('snapToGrid(at)')
  })

  it('costs a disabled deployment no storage read at all', () => {
    // This is called from every roster broadcast. The default is off, and the
    // default must not pay for the feature.
    const body = bodyOf('private async liveHoneypots(')
    expect(body).toMatch(/if\s*\(!this\.honeypotsAllowed\)\s*return\s*\[\]/)
    expect(body.indexOf('honeypotsAllowed')).toBeLessThan(body.indexOf('storage.list'))
  })

  it('keeps a decoy out of the match keyspace every sweep lists', () => {
    // `matchRecords()` lists `match:` and feeds every sweep; a decoy visible to
    // one of them would be swept as though it were a match.
    expect(poolSource).toContain("const HONEYPOT_PREFIX = 'honeypot:'")
    expect(poolSource).not.toContain('`match:${decoy')
  })

  it('takes a decoy off the roster the instant it is matched', () => {
    const body = bodyOf('private async matchHoneypot(')
    // Built rather than written out: a literal `${…}` inside a plain string is
    // a real bug everywhere else, and the lint that catches it is worth more
    // than the convenience of spelling this one assertion directly.
    const brace = String.fromCharCode(36, 123)
    expect(body).toContain(`storage.delete(\`${brace}HONEYPOT_PREFIX}${brace}decoy.id}\`)`)
  })

  it('offers a decoy only as a fallback, and only outside the cooldown', () => {
    const join = bodyOf('private async handleJoin(')
    expect(join).toContain('this.honeypotCooldown(identity.userId')
    // The matcher moved into `pairOff` when #160 gave a requeue a way to reach
    // it; the decoys are still stocked on the join and passed in from there.
    expect(join).toContain('this.stockHoneypots(identity, dealId, deal.merchant')
    expect(join).toContain('this.pairOff(ws, identity, deal, offered)')
    expect(bodyOf('private async pairOff(')).toContain('honeypotCandidate(decoy)')
  })

  it('starts that cooldown at the bow-out, for both sides', () => {
    const body = bodyOf('private async bowOutHoneypot(')
    expect(body).toContain('this.startHoneypotCooldown(record.orderer.userId, now)')
    expect(body).toContain('this.startHoneypotCooldown(record.receiver.userId, now)')
  })

  it('never stocks or offers a decoy to a buyer a teardown just handed back', () => {
    // The #160 caveat, and the reason a requeue calls `pairOff` rather than
    // re-running the join path: a buyer a decoy stood up must not be handed
    // straight to another one, and a teardown is not a join — it has no
    // stock/cooldown decision to make.
    const body = bodyOf('private async rematchRequeued(')
    expect(body).toContain('this.pairOff(ws, state, deal, [])')
    expect(body).not.toContain('stockHoneypots')
    expect(body).not.toContain('nearbyHoneypots')
    expect(body).not.toContain('honeypotCooldown')
    // And the join is still the only place decoys are stocked at all.
    expect(poolSource.match(/this\.stockHoneypots\(/g) ?? []).toHaveLength(1)
  })

  it('re-runs the matcher for every buyer a teardown returns to the queue', () => {
    // The defect #160 is about: three teardowns wrote a `waiting` state inline
    // and stopped there, so `findMatch` ran on `join` and nowhere else. Honeypots
    // made that the common case — two buyers seconds apart into one empty market
    // are each paired with a decoy, and when both bow out neither is ever
    // matched. Enumerated by teardown so a fourth cannot quietly omit it.
    for (const teardown of [
      'private async bowOutHoneypot(',
      'private async unwindMatch(',
      'private async handleDisconnect(',
    ]) {
      const body = bodyOf(teardown)
      expect(body, `${teardown} writes its own waiting state`).not.toContain("status: 'waiting'")
      expect(body, `${teardown} requeues without re-matching`).toContain(
        'this.rematchRequeued(requeued)',
      )
      // The frame that explains the teardown first, and the dead match retired
      // before that: a `matched` arriving ahead of `buddy_left` reads on screen
      // as a match that immediately ended.
      expect(body.indexOf('this.requeue(')).toBeLessThan(body.indexOf('this.rematchRequeued('))
      expect(body.indexOf('this.retireMatch(')).toBeLessThan(body.indexOf('this.rematchRequeued('))
    }
  })

  it('strikes a requeued buyer’s match through the same path a join does', () => {
    // No second match-creation site: one place writes the record, releases (or
    // withholds) the code, decides the disposition and opens the charges.
    // A fresh record is the one with no confirmations yet, which tells a
    // *creation* apart from the four places that rewrite a live record's ledger.
    // Two of them: `pairOff` and `matchHoneypot`, the latter deliberately
    // separate — see its own comment — and nothing else.
    expect(poolSource.match(/confirmations: noConfirmations\(\)/g) ?? []).toHaveLength(2)
    expect(poolSource.match(/generatePickupCode\(\)/g) ?? []).toHaveLength(2)
    const pair = bodyOf('private async pairOff(')
    expect(pair).toContain('generatePickupCode()')
    expect(pair).toContain('codeAtMatchTime(disposition)')
    expect(pair).toContain('this.startPayments(matchId, disposition, deal.label, settlement)')
  })
})

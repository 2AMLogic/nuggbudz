import { describe, expect, it } from 'vitest'
import {
  CHAT_ERROR_CODES,
  CHAT_FRAME_LIMIT,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  isChatErrorCode,
  MAX_CHAT_CHARS,
  reviewChatText,
} from '../shared/chat'
import { sanitizeDemoName } from '../shared/demo'
import type { ProtocolErrorCode } from '../shared/protocol'
import { slidingWindow } from '../shared/ratelimit'
import { countCodePoints, sanitizeDisplayText } from '../shared/text'

/** The accepted text, or a thrown assertion — most cases here expect acceptance. */
function accepted(raw: unknown): string {
  const verdict = reviewChatText(raw)
  if (!verdict.ok) throw new Error(`expected acceptance, got ${verdict.reason}`)
  return verdict.text
}

describe('reviewChatText — hostile input', () => {
  it('keeps an ordinary message', () => {
    expect(accepted("I'm by the drinks, grey hoodie")).toBe("I'm by the drinks, grey hoodie")
  })

  it('trims and collapses whitespace', () => {
    expect(accepted('   two    minutes   out  ')).toBe('two minutes out')
  })

  it('normalizes whitespace BEFORE stripping controls, so a newline separates', () => {
    // The ordering regression this repo has already had once: a newline is
    // whitespace that happens to sit below the printable range, so stripping
    // control characters first would glue the words together.
    expect(accepted('hi\nthere')).toBe('hi there')
    expect(accepted('hi\tthere')).toBe('hi there')
    expect(accepted('hi\r\nthere')).toBe('hi there')
    expect(accepted('hi\nthere')).not.toBe('hithere')
  })

  it('strips C0 control characters and DEL', () => {
    expect(accepted(`at${String.fromCharCode(0)}the${String.fromCharCode(27)} door`)).toBe(
      'atthe door',
    )
    expect(reviewChatText(String.fromCharCode(127))).toEqual({ ok: false, reason: 'empty' })
  })

  it('strips C1 control characters (U+0080-U+009F), which \\s does not match', () => {
    expect(accepted(`grey${String.fromCharCode(0x85)}hoodie`)).toBe('greyhoodie')
    expect(reviewChatText(String.fromCharCode(0x9f))).toEqual({ ok: false, reason: 'empty' })
  })

  it('strips zero-width and bidi-override format characters (Unicode Cf)', () => {
    // Zero-width space, and the RTL override that makes text render differently
    // from its bytes — the display-spoofing primitive this guards against.
    expect(accepted(`by${String.fromCharCode(0x200b)}the door`)).toBe('bythe door')
    expect(accepted(`by${String.fromCharCode(0x202e)}the door`)).toBe('bythe door')
  })

  it('refuses a message with nothing readable in it', () => {
    const invisible = [0x200b, 0x200c, 0x200d, 0xfeff, 0x202e]
      .map((code) => String.fromCharCode(code))
      .join('')
    expect(reviewChatText(invisible)).toEqual({ ok: false, reason: 'empty' })
    expect(reviewChatText('')).toEqual({ ok: false, reason: 'empty' })
    expect(reviewChatText('    ')).toEqual({ ok: false, reason: 'empty' })
    // A non-string arrives whenever a caller hand-rolls a frame.
    expect(reviewChatText(42)).toEqual({ ok: false, reason: 'empty' })
    expect(reviewChatText(null)).toEqual({ ok: false, reason: 'empty' })
  })

  it('leaves emoji and non-Latin text intact', () => {
    expect(accepted('Я у напитков')).toBe('Я у напитков')
    expect(accepted('got the 🍗')).toBe('got the 🍗')
  })
})

describe('reviewChatText — the length cap', () => {
  it('accepts a message exactly at the cap', () => {
    const text = 'x'.repeat(MAX_CHAT_CHARS)
    expect(accepted(text)).toBe(text)
  })

  it('refuses one character over the cap rather than truncating it', () => {
    // Truncation would deliver a sentence nobody wrote. Refusing tells the
    // sender, who can shorten it themselves.
    expect(reviewChatText('x'.repeat(MAX_CHAT_CHARS + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    })
    expect(reviewChatText('x'.repeat(4_000))).toEqual({ ok: false, reason: 'too_long' })
  })

  it('counts code points, so a message of emoji is not secretly double length', () => {
    // Each 🍗 is a surrogate pair: 2 UTF-16 code units, 1 character to a person.
    const emoji = '🍗'.repeat(MAX_CHAT_CHARS)
    expect(countCodePoints(accepted(emoji))).toBe(MAX_CHAT_CHARS)
    expect(reviewChatText('🍗'.repeat(MAX_CHAT_CHARS + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    })
  })

  it('never returns a lone surrogate at the cap boundary', () => {
    const text = `${'x'.repeat(MAX_CHAT_CHARS - 1)}🍗`
    const result = accepted(text)
    expect(result).toBe(text)
    expect(result).not.toContain('�')
  })

  it('measures the message a person sent, not the padding around it', () => {
    // Zero-width padding and whitespace are removed before the cap is judged, so
    // this is a short message wearing a long costume.
    const padded = `${'​'.repeat(3_000)}  by the drinks  `
    expect(accepted(padded)).toBe('by the drinks')
  })

  it('has a frame bound well above the policy cap and well below a flood', () => {
    // The two bounds answer different questions: the frame limit stops a
    // megabyte being sanitized at all, the char cap stops an essay being read
    // out at a counter. Collapsing them would refuse legitimate padded text.
    expect(CHAT_FRAME_LIMIT).toBeGreaterThan(MAX_CHAT_CHARS * 4)
    expect(CHAT_FRAME_LIMIT).toBeLessThan(64 * 1024)
  })
})

describe('the chat rate limit reuses the socket limiter', () => {
  it('allows a burst up to the limit and then refuses, per the shared window', () => {
    // Driven exactly the way `worker/pool.ts` drives it, so this pins the
    // thresholds. That the *socket* actually consults it is proved in
    // `scripts/smoke.mjs`, by flooding a real connection — a unit test calling
    // the helper cannot tell an enforced limit from a decorative one.
    let hits: number[] = []
    const now = 1_000_000
    for (let i = 0; i < CHAT_RATE_LIMIT; i++) {
      const verdict = slidingWindow(hits, now + i, CHAT_RATE_WINDOW_MS, CHAT_RATE_LIMIT)
      expect(verdict.allowed).toBe(true)
      hits = verdict.hits
    }
    const refused = slidingWindow(hits, now + CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS, CHAT_RATE_LIMIT)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('lets a sender back in once the window slides', () => {
    let hits: number[] = []
    for (let i = 0; i < CHAT_RATE_LIMIT; i++) {
      hits = slidingWindow(hits, 1_000 + i, CHAT_RATE_WINDOW_MS, CHAT_RATE_LIMIT).hits
    }
    const later = 1_000 + CHAT_RATE_WINDOW_MS + 1
    expect(slidingWindow(hits, later, CHAT_RATE_WINDOW_MS, CHAT_RATE_LIMIT).allowed).toBe(true)
  })

  it('is generous enough for a person and tight enough to matter', () => {
    expect(CHAT_RATE_LIMIT).toBeGreaterThanOrEqual(3)
    expect(CHAT_RATE_LIMIT).toBeLessThanOrEqual(20)
  })
})

describe('one sanitizer, two callers', () => {
  it('chat and the demo name go through the same hardened path', () => {
    // The guarantee worth pinning: hardening `sanitizeDisplayText` hardens both.
    // If chat ever grows a sanitizer of its own, these stop agreeing.
    const hostile = `Ro${String.fromCharCode(0)}bb\nW${String.fromCharCode(0x200b)}alters`
    expect(sanitizeDemoName(hostile)).toBe('Robb Walters')
    expect(accepted(hostile)).toBe('Robb Walters')
  })

  it('differs only in the policy each caller owns: the cap and the fallback', () => {
    // A name that survives nothing becomes 'Guest'; a message that survives
    // nothing is refused, because there is no such thing as a guest sentence.
    expect(sanitizeDemoName('​')).toBe('Guest')
    expect(reviewChatText('​')).toEqual({ ok: false, reason: 'empty' })
    // And the caps are genuinely different, so one shared cap was not smuggled in.
    expect(sanitizeDemoName('x'.repeat(200))).toHaveLength(40)
    expect(accepted('x'.repeat(MAX_CHAT_CHARS))).toHaveLength(MAX_CHAT_CHARS)
  })

  it('sanitizeDisplayText reports "nothing survived" rather than guessing', () => {
    expect(sanitizeDisplayText('​‮', 40)).toBe('')
    expect(sanitizeDisplayText(undefined, 40)).toBe('')
  })
})

/**
 * Which control on the matched screen a refusal belongs to.
 *
 * Typed as a total map over `ProtocolErrorCode`, which is the point: the two
 * surfaces share one socket and one `error` frame, so adding a code without
 * deciding where it renders is the bug this table prevents. A new code fails to
 * compile here until it is classified, rather than silently appearing under the
 * chat box — which is exactly how "wrong pickup code" once got reported as a chat
 * problem.
 */
const SURFACE: Record<ProtocolErrorCode, 'chat' | 'elsewhere'> = {
  bad_message: 'elsewhere',
  unknown_deal: 'elsewhere',
  already_waiting: 'elsewhere',
  already_matched: 'elsewhere',
  not_waiting: 'elsewhere',
  // A chat send can earn this one, but it says the match is over — a fact about
  // the whole screen, not about the line just typed.
  not_matched: 'elsewhere',
  unknown_sauce: 'elsewhere',
  bad_pickup_code: 'elsewhere',
  already_confirmed: 'elsewhere',
  match_disputed: 'elsewhere',
  chat_empty: 'chat',
  chat_too_long: 'chat',
  chat_rate_limited: 'chat',
  buddy_offline: 'chat',
}

describe('error routing between the two controls of a match', () => {
  it('classifies every protocol error code, and agrees with the table', () => {
    for (const [code, surface] of Object.entries(SURFACE)) {
      expect(isChatErrorCode(code), code).toBe(surface === 'chat')
    }
  })

  it('routes the refusals a chat send can earn, and no others', () => {
    // Pinned as a set so a code cannot be quietly dropped from the list: losing
    // one would leave that refusal rendering on the pickup surface, where the
    // matched screen does not look for it.
    expect([...CHAT_ERROR_CODES].sort()).toEqual([
      'buddy_offline',
      'chat_empty',
      'chat_rate_limited',
      'chat_too_long',
    ])
  })

  it('keeps the pickup refusals off the chat input', () => {
    // The regression that motivated the split: both of these reached the chat
    // box, styled as though the chat had refused them.
    expect(isChatErrorCode('bad_pickup_code')).toBe(false)
    expect(isChatErrorCode('already_confirmed')).toBe(false)
  })
})

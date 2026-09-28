/**
 * Nuggchat policy: what a matched buddy may say, and how often.
 *
 * Pure decisions only, like `shared/ratelimit.ts` — the Durable Object owns the
 * sockets and the per-connection counters, this owns the thresholds so they can
 * be tested without a Workers runtime.
 *
 * The one thing worth stating loudly: **there is no storage here, and there is
 * none anywhere downstream.** A chat message is relayed to the buddy's live
 * socket or it is refused. Nothing is written to D1, to Durable Object storage
 * or to KV, which is why the screen can honestly tell a buyer the conversation
 * disappears. See the reasoning in the "ephemeral" section of the issue: it
 * keeps conversation out of a ledger hardened to accept only authentic
 * settlements, and it keeps a hackathon build out of a moderation surface
 * nobody can staff.
 */
import { countCodePoints, sanitizeDisplayText } from './text'

/**
 * Longest message a buddy may send, counted the way a person counts it.
 *
 * This is "I'm by the drinks, grey hoodie" territory, not correspondence. A
 * short cap is also the cheapest defence against a socket used as a pipe.
 */
export const MAX_CHAT_CHARS = 160

/**
 * Largest raw frame the parser will even look at.
 *
 * `MAX_CHAT_CHARS` is the *policy* cap and is applied to sanitized text, so the
 * parser cannot use it: escapes, controls and zero-width padding all shrink
 * under sanitizing, and rejecting on raw length would refuse legitimate text.
 * This is the separate structural bound that stops a megabyte frame from being
 * sanitized at all — well above anything a person types, well below anything
 * worth a Durable Object's time.
 */
export const CHAT_FRAME_LIMIT = 4_096

/** Messages one connection may send per `CHAT_RATE_WINDOW_MS`. */
export const CHAT_RATE_LIMIT = 6
export const CHAT_RATE_WINDOW_MS = 10_000

/**
 * How many lines a client keeps on screen.
 *
 * Nothing is persisted, so this is not a retention policy — it is a bound on an
 * in-memory array so a long wait at the counter cannot grow one without limit.
 */
export const MAX_CHAT_HISTORY = 50

/**
 * The refusals a buyer earns by *saying something*, as opposed to by anything
 * else they do with their match.
 *
 * The matched screen has two controls sharing one socket — the chat input and the
 * pickup confirmation — and therefore one `error` frame between them. This list
 * is what tells a client which of the two a refusal is about, so it lives here
 * rather than in the client: `ProtocolErrorCode` is built from it, which means a
 * new chat refusal cannot be emitted by the server without also being routed on
 * screen. The alternative, once shipped, put "wrong pickup code" under the chat
 * box styled as a chat refusal.
 *
 * `not_matched` is not here even though a chat send can earn it: it says the
 * match is over, which is a fact about the whole screen rather than about the
 * line just typed.
 */
export const CHAT_ERROR_CODES = [
  /** Nothing printable survived sanitizing — an all-zero-width message, say. */
  'chat_empty',
  'chat_too_long',
  'chat_rate_limited',
  /**
   * Still matched, but the buddy's socket is gone. The message is dropped and
   * said to be dropped: a relay with no live recipient must never look like a
   * queued one.
   */
  'buddy_offline',
] as const

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number]

/** Whether a refusal belongs under the chat input rather than by the pickup code. */
export function isChatErrorCode(code: string): code is ChatErrorCode {
  return (CHAT_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * The verdict on one untrusted message body.
 *
 * `too_long` is reported rather than truncated on purpose. Silently cutting a
 * stranger's sentence in half and delivering the remainder is worse than telling
 * the sender it did not fit: the buddy would read something nobody wrote.
 */
export type ChatReview = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' }

/**
 * Clean and measure a message body.
 *
 * Sanitizing runs through the shared hardened path — the same one that cleans a
 * demo display name — so control characters, C1, zero-width and bidi overrides
 * are already gone by the time the length is judged. That ordering matters: a
 * message padded to 300 characters with zero-width joiners is a short message,
 * and a message hidden inside bidi overrides is not a way to smuggle one past
 * the cap.
 */
export function reviewChatText(raw: unknown): ChatReview {
  // Capped one past the policy limit, which is what makes "too long" detectable
  // at all while still bounding the work: a 160-character cap would return
  // something that looks exactly like a message that fit.
  const cleaned = sanitizeDisplayText(raw, MAX_CHAT_CHARS + 1)
  if (cleaned.length === 0) return { ok: false, reason: 'empty' }
  if (countCodePoints(cleaned) > MAX_CHAT_CHARS) return { ok: false, reason: 'too_long' }
  return { ok: true, text: cleaned }
}

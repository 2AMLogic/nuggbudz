/**
 * Cleaning untrusted text before a stranger is shown it.
 *
 * One code path, deliberately. This is the sanitizer that grew up as
 * `sanitizeDemoName` in `shared/demo.ts`, and it has been hardened twice already
 * — grapheme-safe capping, C0/C1 controls, zero-width characters, bidi
 * overrides, lone surrogates. Nuggchat renders text one stranger typed straight
 * to another, which is precisely the same threat, so it calls this rather than
 * growing a second sanitizer that would have to relearn every one of those
 * lessons. A rule added here fixes every caller at once, and that is the point.
 */

/**
 * Every control character (`\p{Cc}`: C0, DEL, and the C1 block U+0080-U+009F),
 * Unicode format character (`\p{Cf}`: zero-width space/joiner/non-joiner, BOM,
 * bidi override/isolate marks — invisible, and U+202E in particular can make
 * text render differently from its bytes) and lone surrogate (`\p{Cs}`: half of
 * a split surrogate pair, which decodes to U+FFFD wherever it lands) in one
 * pass. A single `.replace` over the whole string, not a per-character
 * `.filter`, so there is no stateful global regex whose `lastIndex` a reused
 * `.test()` call could silently skip past.
 */
const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu

/**
 * Split text the way a person would count characters: by grapheme cluster, so a
 * base letter and a combining mark it carries, or a multi-code-point emoji,
 * never get separated by a cap landing in the middle of one.
 *
 * Falls back to code-point splitting where `Intl.Segmenter` does not exist.
 * That still can't split a surrogate pair (the fallback #41 fixed), it just
 * cannot keep a base letter and a trailing combining mark together — a narrower
 * gap than not having the fallback at all.
 */
function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (entry) => entry.segment)
  }
  return Array.from(text)
}

/**
 * Reduce arbitrary input to printable text of at most `maxGraphemes` characters,
 * counted the way a person would count them.
 *
 * Returns the empty string when nothing printable survives. Callers decide what
 * that means, because a display name falls back to `Guest` while a chat message
 * is refused outright.
 */
export function sanitizeDisplayText(raw: unknown, maxGraphemes: number): string {
  if (typeof raw !== 'string') return ''
  // Whitespace first, control characters second. A newline or tab is whitespace
  // that happens to sit below the printable range, so deleting it before this
  // step would glue two words together ('hi\nthere' -> 'hithere') instead of
  // separating them. A test pins this ordering; it has been got backwards before.
  const spaced = raw.replace(/\s/g, ' ')
  const printable = spaced.replace(CONTROL_OR_INVISIBLE, '')
  const cleaned = printable.replace(/ +/g, ' ').trim()
  if (cleaned.length === 0) return ''
  // Cap on grapheme clusters, not code points or UTF-16 code units — slicing by
  // code unit can split a surrogate pair (e.g. an emoji) in two, and slicing by
  // code point can split a base letter from a combining mark it carries. Trim
  // after capping so the cap itself can't leave a trailing space.
  return graphemes(cleaned).slice(0, maxGraphemes).join('').trim()
}

/** Length as a person counts it: code points, so one emoji is one character. */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

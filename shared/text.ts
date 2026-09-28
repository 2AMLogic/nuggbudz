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

/** Space, the lowest printable code point. Anything below it is a control char. */
const FIRST_PRINTABLE = 0x20
const DELETE_CHAR = 0x7f

/**
 * Reduce arbitrary input to printable text of at most `maxCodePoints`.
 *
 * Returns the empty string when nothing printable survives. Callers decide what
 * that means, because a display name falls back to `Guest` while a chat message
 * is refused outright.
 */
export function sanitizeDisplayText(raw: unknown, maxCodePoints: number): string {
  if (typeof raw !== 'string') return ''
  // Whitespace first, control characters second. A newline or tab is whitespace
  // that happens to sit below the printable range, so deleting it before this
  // step would glue two words together ('hi\nthere' -> 'hithere') instead of
  // separating them. A test pins this ordering; it has been got backwards before.
  const spaced = raw.replace(/\s/g, ' ')
  const printable = Array.from(spaced)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      if (code < FIRST_PRINTABLE || code === DELETE_CHAR) return false
      // C1 control block (U+0080-U+009F) — not caught by \s or the C0/DEL check.
      if (code >= 0x80 && code <= 0x9f) return false
      // Unicode format characters (category Cf): zero-width space/joiner/
      // non-joiner, BOM, bidi override/isolate marks. These are invisible and
      // U+202E in particular can make text render differently from its bytes,
      // so they are stripped rather than displayed. No /g flag here — a stateful
      // global regex reused across `.filter()` calls silently skips matches via
      // `lastIndex`.
      if (/\p{Cf}/u.test(ch)) return false
      return true
    })
    .join('')
  const cleaned = printable.replace(/ +/g, ' ').trim()
  if (cleaned.length === 0) return ''
  // Cap on code points, not UTF-16 code units — slicing by code unit can split
  // a surrogate pair (e.g. an emoji) in two, leaving a lone surrogate that
  // decodes to U+FFFD. Trim after capping so the cap itself can't leave a
  // trailing space.
  return Array.from(cleaned).slice(0, maxCodePoints).join('').trim()
}

/** Length as a person counts it: code points, so one emoji is one character. */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

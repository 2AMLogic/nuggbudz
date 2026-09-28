import { Perf } from './Roll'

/**
 * Where a handoff link lands when it could not carry you into the match.
 *
 * This is the degradation path, and it is the reason the QR carries a link at
 * all rather than nothing. The scanner may be a phone with no session here, a
 * browser that dropped its demo cookie, a bystander who photographed the symbol
 * across the table, or simply somebody whose match is open on a different
 * device. None of them can confirm anything — the server only takes a
 * `confirm_pickup` from the socket that *is* the receiver of that match — so
 * what this screen owes them is the one thing a link can honestly give: six
 * characters, big enough to read out and type into whichever screen is actually
 * holding the match.
 *
 * `resolving` is the fraction of a second between the socket opening and the
 * server saying whether it knows this browser as half of a live handoff. Showing
 * the fallback immediately and then replacing it would flash the wrong answer
 * first.
 */
export function HandoffCard({
  code,
  resolving,
  onDismiss,
}: {
  code: string
  resolving: boolean
  onDismiss: () => void
}) {
  return (
    <section aria-live="polite">
      <p className="font-display text-[0.65rem] tracking-[0.2em] text-faded uppercase">
        Pickup code
      </p>
      <h2 className="mt-1 font-display text-4xl font-bold tracking-[0.3em]">{code}</h2>

      <Perf label={resolving ? 'Checking' : 'Read it out'} />

      {resolving ? (
        <p className="font-body text-base leading-snug text-faded">
          Seeing whether this device is the one in the match.
        </p>
      ) : (
        <p className="font-body text-base leading-snug">
          This device is not the one holding that match. Type these six characters into the screen
          that is — nothing settles until somebody taps, on both sides.
        </p>
      )}

      <button
        type="button"
        onClick={onDismiss}
        className="mt-7 w-full border-2 border-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] uppercase transition-transform active:translate-y-px"
      >
        Back to NuggBudz
      </button>
    </section>
  )
}

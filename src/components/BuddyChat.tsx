import { MAX_CHAT_CHARS } from '@shared/chat'
import type { BuyerRole } from '@shared/economics'
import { useEffect, useRef, useState } from 'react'
import type { ChatLine } from '../hooks/usePool'

/**
 * Nuggchat: two lines of conversation to find each other at the counter.
 *
 * "I'm by the drinks." "Grey hoodie." "Two minutes out." That is the whole
 * purpose, and the cap on a message is sized for it.
 *
 * The notice under the transcript is not decoration. The server relays these
 * messages and stores none of them — no ledger row, no Durable Object key, no
 * KV entry — so `lines` is the only copy in existence and it is dropped the
 * moment the match ends. The sentence on screen is therefore literally true,
 * which is the register `useCoords.ts` and the demo-mode notice set: say plainly
 * what the software does, including when that is "nothing".
 */
export function BuddyChat({
  lines,
  myRole,
  buddyName,
  error,
  onSend,
}: {
  lines: ChatLine[]
  /** This buyer's side of the match, so their own lines can be marked as theirs. */
  myRole: BuyerRole
  buddyName: string
  /** A refusal from the server — over the length cap, or sending too fast. */
  error: string | null
  onSend: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  // Follow the conversation as it arrives, the way any chat does.
  useEffect(() => {
    if (lines.length === 0) return
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [lines])

  const send = () => {
    if (draft.trim().length === 0) return
    onSend(draft)
    setDraft('')
  }

  return (
    <section aria-label={`Chat with ${buddyName}`}>
      <div
        className="max-h-44 overflow-y-auto border-2 border-hairline px-3 py-2"
        aria-live="polite"
      >
        {lines.length === 0 ? (
          <p className="font-body text-sm leading-snug text-faded">
            Say where you are standing. {buddyName} sees it straight away.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {lines.map((line) => (
              // `seq` and not `at`: two messages can land in the same millisecond.
              <li key={line.seq} className="font-body text-sm leading-snug">
                <span
                  className={`font-display text-[0.6rem] tracking-[0.12em] uppercase ${
                    line.from === myRole ? 'text-faded' : 'text-ketchup'
                  }`}
                >
                  {line.from === myRole ? 'You' : line.name}
                </span>{' '}
                <span className="break-words">{line.text}</span>
              </li>
            ))}
          </ul>
        )}
        <div ref={endRef} />
      </div>

      <div className="mt-2 flex items-stretch gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            send()
          }}
          // The server enforces this cap too, and its answer is authoritative —
          // this only spares an honest buyer from typing past it.
          maxLength={MAX_CHAT_CHARS}
          aria-label={`Message ${buddyName}`}
          placeholder="By the drinks, grey hoodie"
          className="min-w-0 flex-1 border-b-2 border-ink bg-transparent px-1 py-2 font-body text-sm focus:outline-none"
        />
        <button
          type="button"
          onClick={send}
          disabled={draft.trim().length === 0}
          className="border-2 border-ink px-3 font-display text-[0.65rem] font-bold tracking-[0.15em] uppercase transition-transform active:translate-y-px disabled:opacity-35"
        >
          Send
        </button>
      </div>

      {error !== null && <p className="mt-2 font-body text-sm text-ketchup">{error}</p>}

      <p className="mt-2 font-body text-xs leading-snug text-faded">
        Nothing here is saved. Messages go straight to {buddyName} and nowhere else — not to the
        ledger, not to us — and the whole conversation disappears the moment this match is done.
      </p>
    </section>
  )
}

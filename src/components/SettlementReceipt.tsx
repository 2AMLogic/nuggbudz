import { findDeal } from '@shared/deals'
import type { BuyerRole } from '@shared/economics'
import { formatCents } from '@shared/economics'
import { formatDistance } from '@shared/geo'
import { PICKUP_CODE_LENGTH } from '@shared/pickup'
import type { MatchedMessage } from '@shared/protocol'
import { useState } from 'react'
import type { ChatLine } from '../hooks/usePool'
import { Barcode } from './Barcode'
import { BuddyChat } from './BuddyChat'
import { Line, Perf } from './Roll'

/**
 * The signature screen: the match arrives as a receipt that prints itself.
 *
 * Every figure here comes off the settlement the server computed, so the split
 * shown to both buddies is the same split, down to the cent.
 */
export function SettlementReceipt({
  match,
  confirmed,
  waitingOn,
  stage,
  notice,
  chat,
  chatError,
  onConfirm,
  onSendChat,
  onDone,
}: {
  match: MatchedMessage
  /** Sides of the handoff confirmed so far. */
  confirmed: BuyerRole[]
  waitingOn: BuyerRole | null
  stage: 'matched' | 'settled' | 'disputed'
  notice: string | null
  /** The live conversation. Empty once the match is over, because it is gone. */
  chat: ChatLine[]
  chatError: string | null
  onConfirm: (code?: string) => void
  onSendChat: (text: string) => void
  onDone: () => void
}) {
  const deal = findDeal(match.settlement.dealId)
  const { settlement, share, buddy, role } = match
  const [typedCode, setTypedCode] = useState('')
  const iConfirmed = confirmed.includes(role)

  const instruction =
    role === 'orderer'
      ? `You order the box. ${buddy.name} comes to you.`
      : `${buddy.name} orders the box. Go meet them.`

  return (
    <section aria-live="polite">
      <p
        className="printed font-display text-[0.65rem] tracking-[0.2em] text-faded uppercase"
        style={{ animationDelay: '0ms' }}
      >
        Matched
      </p>
      <h2
        className="printed mt-1 font-display text-2xl font-bold leading-tight"
        style={{ animationDelay: '80ms' }}
      >
        {buddy.name}
      </h2>
      <p
        className="printed font-display text-[0.7rem] tracking-[0.12em] text-faded uppercase"
        style={{ animationDelay: '140ms' }}
      >
        {formatDistance(buddy.distanceMeters)}
      </p>

      <Perf label={deal?.merchant ?? 'Order'} />

      <Line
        label={deal?.bulk.item ?? 'Bulk box'}
        value={formatCents(settlement.cogsCents)}
        delay={200}
      />
      <Line label="Pairing fee" value={formatCents(settlement.platformFeeCents)} delay={260} />

      <Perf />

      <Line
        label="Total collected"
        value={formatCents(settlement.totalCollectedCents)}
        emphasis="total"
        delay={320}
      />
      <Line label={`Split ${settlement.partySize} ways`} value="" delay={380} />
      <Line label="Your half" value={formatCents(share.payCents)} emphasis="total" delay={440} />
      <Line label="Your nuggets" value={`${share.piecesOwed} pc`} delay={500} />

      <Perf />

      <Line label="Solo price" value={formatCents(share.soloBaselineCents)} delay={560} />
      <Line
        label={`You saved (${share.savingsPct}%)`}
        value={formatCents(share.savingsCents)}
        emphasis="savings"
        delay={620}
      />

      <Perf
        label={stage === 'settled' ? 'Settled' : stage === 'disputed' ? 'Disputed' : 'Pickup'}
      />

      {stage === 'settled' ? (
        <>
          <p className="printed font-body text-base leading-snug">
            Both of you confirmed the handoff. The split is on the books.
          </p>
          <button type="button" onClick={onDone} className={PRIMARY}>
            Done
          </button>
        </>
      ) : stage === 'disputed' ? (
        <>
          <p className="printed font-body text-base leading-snug text-ketchup">
            {notice ?? 'Only one of you confirmed the handoff. This split is flagged for review.'}
          </p>
          <button type="button" onClick={onDone} className={PRIMARY}>
            Done
          </button>
        </>
      ) : (
        <>
          <p
            className="printed font-body text-base leading-snug"
            style={{ animationDelay: '700ms' }}
          >
            {instruction}
          </p>

          {match.pickupCode !== null && (
            <div className="printed mt-5" style={{ animationDelay: '760ms' }}>
              <Barcode value={match.pickupCode} />
              <p className="mt-2 font-display text-lg font-bold tracking-[0.35em]">
                {match.pickupCode}
              </p>
              <p className="font-display text-[0.6rem] tracking-[0.15em] text-faded uppercase">
                Read this out to your bud
              </p>
            </div>
          )}

          {role === 'receiver' && !iConfirmed && (
            <label className="mt-5 block">
              <span className="font-display text-[0.65rem] tracking-[0.15em] text-faded uppercase">
                The code on {buddy.name}'s receipt
              </span>
              <input
                value={typedCode}
                onChange={(event) => setTypedCode(event.target.value.toUpperCase())}
                maxLength={PICKUP_CODE_LENGTH + 2}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="------"
                className="mt-2 w-full border-b-2 border-ink bg-transparent px-1 py-2 font-display text-lg tracking-[0.35em] focus:outline-none"
              />
            </label>
          )}

          {/* Only while the match is live. There is no chat before a match and
              none after one, on screen or on the server. */}
          <Perf label="Find each other" />
          <BuddyChat
            lines={chat}
            myRole={role}
            buddyName={buddy.name}
            error={chatError}
            onSend={onSendChat}
          />

          <Perf />

          {iConfirmed ? (
            <p className="mt-7 font-body text-sm leading-snug text-faded" aria-live="polite">
              You confirmed. Waiting on {waitingOn === null ? 'your bud' : buddy.name} — nothing
              settles until you both do.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => onConfirm(role === 'receiver' ? typedCode : undefined)}
              disabled={role === 'receiver' && typedCode.trim().length === 0}
              className={`${PRIMARY} disabled:opacity-35`}
            >
              {role === 'orderer' ? 'Handed it over' : 'Got the box'}
            </button>
          )}

          <button
            type="button"
            onClick={onDone}
            className="mt-4 w-full font-display text-[0.65rem] tracking-[0.15em] text-faded uppercase underline"
          >
            Leave this match
          </button>
        </>
      )}
    </section>
  )
}

const PRIMARY =
  'mt-7 w-full bg-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] text-paper uppercase transition-transform active:translate-y-px'

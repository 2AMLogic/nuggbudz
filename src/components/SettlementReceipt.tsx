import { findDeal } from '@shared/deals'
import type { BuyerRole } from '@shared/economics'
import { formatCents } from '@shared/economics'
import { formatDistance } from '@shared/geo'
import { PICKUP_CODE_LENGTH } from '@shared/pickup'
import type { MatchedMessage, PaymentRequiredMessage } from '@shared/protocol'
import { describeStanding } from '@shared/reputation'
import { describeSauceSelection, type SauceSelection } from '@shared/sauces'
import { useState } from 'react'
import type { ChatLine } from '../hooks/usePool'
import { BuddyChat } from './BuddyChat'
import { CodeScanner } from './CodeScanner'
import { PaymentPanel } from './PaymentPanel'
import { PickupQr } from './PickupQr'
import { Line, Perf } from './Roll'

/**
 * The match arrives as a receipt that prints itself.
 *
 * Every figure here comes off the settlement the server computed, so the split
 * shown to both buddies is the same split, down to the cent.
 *
 * It is the one thing on screen that is not part of the rendered world, and it
 * is deliberately the one thing made of paper: a dot-matrix printout on fanfold
 * stock, tractor holes down both edges, ink that does not quite register. The
 * `printout` class redefines the palette tokens for everything below it, so the
 * same `text-steel` that is a cool grey on the console is pencil grey here.
 */
export function SettlementReceipt({
  match,
  payment,
  yourSauces,
  confirmed,
  waitingOn,
  stage,
  notice,
  error,
  chat,
  chatError,
  onConfirm,
  onSendChat,
  onDone,
  initialCode,
}: {
  match: MatchedMessage
  /**
   * Your half, while it is still owed. Non-null means the handoff has not been
   * paid for yet, which is why the pickup block below is replaced by the card
   * form rather than shown alongside it.
   */
  payment: PaymentRequiredMessage | null
  /**
   * Your own pair, from this browser rather than off the wire — the server has no
   * reason to echo back a choice you just made. Null if you picked none.
   */
  yourSauces: SauceSelection | null
  /** Sides of the handoff confirmed so far. */
  confirmed: BuyerRole[]
  waitingOn: BuyerRole | null
  stage: 'matched' | 'settled' | 'disputed'
  notice: string | null
  /**
   * A refusal about the handoff itself — a wrong pickup code, a second
   * confirmation. Shown beside the control that earned it, which is why it is a
   * separate prop from `chatError` rather than one "last error" for the screen.
   */
  error: string | null
  /** The live conversation. Empty once the match is over, because it is gone. */
  chat: ChatLine[]
  /** Why the last line you tried to say did not go. Belongs under the input. */
  chatError: string | null
  onConfirm: (code?: string) => void
  onSendChat: (text: string) => void
  onDone: () => void
  /**
   * A code this browser arrived carrying, because a phone's own camera app
   * opened the handoff link on the orderer's receipt. It seeds the field the
   * receiver would otherwise have typed into, and does nothing else: the tap is
   * still theirs, and the server still checks the code against the record and
   * the role against the socket. Null on every other route to this screen.
   */
  initialCode?: string | null
}) {
  const deal = findDeal(match.settlement.dealId)
  const { settlement, share, buddy, role } = match
  const [typedCode, setTypedCode] = useState(initialCode ?? '')
  const iConfirmed = confirmed.includes(role)

  // Ids resolve to labels through the catalogue, so a buddy's pick is never a
  // string off the wire being rendered — and an id the menu no longer holds shows
  // as nothing rather than as itself.
  const yourOrder = describeSauceSelection(yourSauces)
  const buddyOrder = describeSauceSelection(buddy.sauces)

  // A band becomes words in exactly one place, and that place is not here. There
  // is no count to print even if this screen wanted one: the wire carries the
  // band alone.
  const standing = describeStanding(buddy.standing)

  const instruction =
    role === 'orderer'
      ? `You order the box. ${buddy.name} comes to you.`
      : `${buddy.name} orders the box. Go meet them.`

  return (
    <section className="printout" aria-live="polite">
      <p className="printed tag" style={{ animationDelay: '0ms' }}>
        Matched
      </p>
      <h2 className="printed display mt-1 text-[2rem]" style={{ animationDelay: '80ms' }}>
        {buddy.name}
      </h2>
      <p
        className="printed font-mono text-[0.7rem] tracking-[0.12em] text-steel uppercase"
        style={{ animationDelay: '140ms' }}
      >
        {formatDistance(buddy.distanceMeters)} · {standing.label}
      </p>
      <p
        className="printed mt-1 font-body text-xs leading-snug text-steel"
        style={{ animationDelay: '170ms' }}
      >
        {standing.detail}
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

      {/* The practical half of the sauce chart: whoever is standing at the counter
          is ordering for two, so both pairs are on both receipts. */}
      {(yourOrder !== null || buddyOrder !== null) && (
        <>
          <Perf label="Sauces" />
          <Line label="Yours" value={yourOrder ?? 'Dealer’s choice'} delay={660} />
          <Line label={`${buddy.name}’s`} value={buddyOrder ?? 'Dealer’s choice'} delay={700} />
        </>
      )}

      <Perf
        label={
          stage === 'settled'
            ? 'Settled'
            : stage === 'disputed'
              ? 'Disputed'
              : payment !== null
                ? 'Your half'
                : 'Pickup'
        }
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
      ) : payment !== null ? (
        <>
          {/* Money first. There is deliberately no pickup code and no confirm
              button on this screen: the server has not released one, and the
              handshake it gates is refused until both halves clear. */}
          <p
            className="printed font-body text-base leading-snug"
            style={{ animationDelay: '700ms' }}
          >
            {instruction}
          </p>
          <PaymentPanel payment={payment} />
          <button type="button" onClick={onDone} className="btn-plain mt-4">
            Leave this match
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

          {/* Only the orderer has a code: `pool.ts` fills `pickupCode` for them
              alone, and never before both halves have paid. The QR is governed by
              that same non-null gate, so a client has no way to print a symbol
              for a code it was not given. */}
          {match.pickupCode !== null && (
            <div className="printed mt-5" style={{ animationDelay: '760ms' }}>
              <PickupQr value={match.pickupCode} />
              <p className="mt-3 font-mono text-lg font-bold tracking-[0.35em] text-chrome">
                {match.pickupCode}
              </p>
              <p className="tag">Let your bud scan this, or read it out</p>
            </div>
          )}

          {role === 'receiver' && !iConfirmed && (
            <>
              <label className="mt-5 block">
                <span className="tag">The code on {buddy.name}'s receipt</span>
                <input
                  value={typedCode}
                  onChange={(event) => setTypedCode(event.target.value.toUpperCase())}
                  maxLength={PICKUP_CODE_LENGTH + 2}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="------"
                  className="slot mt-2 text-lg tracking-[0.35em]"
                />
              </label>
              {/* The accelerator, beside the field rather than instead of it: a
                  scan fills the same input, and a camera nobody can or will grant
                  leaves the typed path exactly as it was. */}
              <CodeScanner onScan={setTypedCode} />
            </>
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

          {error !== null && (
            <p className="mt-4 font-body text-sm text-ketchup" aria-live="polite">
              {error}
            </p>
          )}

          {iConfirmed ? (
            <p className="mt-7 font-body text-sm leading-snug text-steel" aria-live="polite">
              You confirmed. Waiting on {waitingOn === null ? 'your bud' : buddy.name} — nothing
              settles until you both do.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => onConfirm(role === 'receiver' ? typedCode : undefined)}
              disabled={role === 'receiver' && typedCode.trim().length === 0}
              className={PRIMARY}
            >
              {role === 'orderer' ? 'Handed it over' : 'Got the box'}
            </button>
          )}

          <button type="button" onClick={onDone} className="btn-plain mt-4">
            Leave this match
          </button>
        </>
      )}
    </section>
  )
}

const PRIMARY = 'btn btn-chrome mt-7'

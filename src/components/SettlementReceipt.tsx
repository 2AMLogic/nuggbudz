import { findDeal } from '@shared/deals'
import { formatCents } from '@shared/economics'
import { formatDistance } from '@shared/geo'
import type { MatchedMessage } from '@shared/protocol'
import { Barcode } from './Barcode'
import { Line, Perf } from './Roll'

/**
 * The signature screen: the match arrives as a receipt that prints itself.
 *
 * Every figure here comes off the settlement the server computed, so the split
 * shown to both buddies is the same split, down to the cent.
 */
export function SettlementReceipt({
  match,
  onDone,
}: {
  match: MatchedMessage
  onDone: () => void
}) {
  const deal = findDeal(match.settlement.dealId)
  const { settlement, share, buddy, role } = match
  const pickupCode = match.matchId.replace(/-/g, '').slice(0, 6).toUpperCase()

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

      <Perf label="Pickup" />

      <p className="printed font-body text-base leading-snug" style={{ animationDelay: '700ms' }}>
        {instruction}
      </p>

      <div className="printed mt-5" style={{ animationDelay: '760ms' }}>
        <Barcode value={pickupCode} />
        <p className="mt-2 font-display text-lg font-bold tracking-[0.35em]">{pickupCode}</p>
        <p className="font-display text-[0.6rem] tracking-[0.15em] text-faded uppercase">
          Show this to your bud
        </p>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="mt-7 w-full bg-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] text-paper uppercase transition-transform active:translate-y-px"
      >
        Got the box
      </button>
    </section>
  )
}

import type { DealSpec, Settlement, SpreadAnalysis } from '@shared/economics'
import { formatCents } from '@shared/economics'
import { useEffect, useState } from 'react'
import { CellMap } from './components/CellMap'
import { Line, Perf, Roll } from './components/Roll'
import { SettlementReceipt } from './components/SettlementReceipt'
import { useCoords } from './hooks/useCoords'
import { usePool } from './hooks/usePool'
import { useSession } from './hooks/useSession'

interface DealWithMath extends DealSpec {
  settlement: Settlement
  spread: SpreadAnalysis
}

export function App() {
  const [deals, setDeals] = useState<DealWithMath[]>([])
  const [dealId, setDealId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const coords = useCoords()
  const pool = usePool()
  const session = useSession()

  useEffect(() => {
    let cancelled = false
    fetch('/api/deals')
      .then((response) => {
        if (!response.ok) throw new Error(`deals request failed: ${response.status}`)
        return response.json() as Promise<{ deals: DealWithMath[] }>
      })
      .then((body) => {
        if (cancelled) return
        setDeals(body.deals)
        setDealId((current) => current ?? body.deals[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load deals. Reload to try again.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Get a location, then take the seat. Deliberately not an effect keyed on the
   * fix: leaving the queue would immediately rejoin on the still-set fix.
   */
  const start = async () => {
    if (dealId === null || session.user === null) return
    const fix = await coords.locate()
    pool.join({ dealId, lat: fix.lat, lng: fix.lng })
  }

  const selected = deals.find((deal) => deal.id === dealId) ?? null
  const canStart = session.user !== null && dealId !== null && !coords.pending

  if (
    pool.match !== null &&
    (pool.stage === 'matched' || pool.stage === 'settled' || pool.stage === 'disputed')
  ) {
    return (
      <Shell cell={pool.cell}>
        <SettlementReceipt
          match={pool.match}
          confirmed={pool.confirmed}
          waitingOn={pool.waitingOn}
          stage={pool.stage}
          notice={pool.notice}
          onConfirm={pool.confirmPickup}
          onDone={pool.leave}
        />
      </Shell>
    )
  }

  if (pool.stage === 'connecting' || pool.stage === 'waiting') {
    return (
      <Shell cell={pool.cell}>
        <section aria-live="polite">
          <p className="font-display text-[0.65rem] tracking-[0.2em] text-faded uppercase">
            {pool.stage === 'connecting' ? 'Joining your cell' : 'Looking for a bud'}
          </p>
          <h2 className="caret mt-1 font-display text-2xl font-bold">
            {pool.stage === 'connecting' ? 'Standing in line' : `${pool.waiting} in your cell`}
          </h2>

          {pool.stage === 'waiting' && pool.cell !== null && pool.own !== null && (
            <CellMap cell={pool.cell} you={pool.own} buddies={pool.buddies} />
          )}

          <Perf label={selected?.merchant ?? 'Deal'} />

          <Line label="Your order" value={selected?.label ?? '—'} />
          <Line
            label="Your half"
            value={formatCents(selected?.settlement.shares[1]?.payCents ?? 0)}
          />
          <Line label="Ahead of you" value={String(pool.queuedAhead)} />

          {pool.notice !== null && (
            <p className="mt-4 font-body text-sm text-ketchup">{pool.notice}</p>
          )}

          <p className="mt-4 font-body text-sm leading-snug text-faded">
            You are paired the moment someone within walking distance wants the same box. Keep this
            open.
          </p>

          <button
            type="button"
            onClick={pool.leave}
            className="mt-7 w-full border-2 border-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] uppercase transition-transform active:translate-y-px"
          >
            Leave the queue
          </button>
        </section>
      </Shell>
    )
  }

  return (
    <Shell cell={pool.cell}>
      <p className="font-body text-base leading-snug">
        Twenty nuggets cost less than ten. Split the box with someone nearby and you both stop
        paying the single-person tax.
      </p>

      <Perf label="Tonight's spread" />

      {loadError !== null && <p className="font-body text-sm text-ketchup">{loadError}</p>}

      <div className="flex flex-col gap-2">
        {deals.map((deal) => {
          const half = deal.settlement.shares[1]
          const active = deal.id === dealId
          return (
            <button
              key={deal.id}
              type="button"
              onClick={() => setDealId(deal.id)}
              aria-pressed={active}
              className={`border-2 px-4 py-3 text-left transition-colors ${
                active ? 'border-ink bg-nugget/20' : 'border-hairline'
              }`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-display text-[0.7rem] tracking-[0.12em] uppercase">
                  {deal.merchant}
                </span>
                <span className="font-display text-base font-bold tabular-nums">
                  {formatCents(half.payCents)}
                </span>
              </span>
              <span className="mt-1 flex items-baseline justify-between gap-2">
                <span className="font-body text-sm text-faded">{deal.label}</span>
                <span className="font-display text-[0.65rem] tracking-[0.1em] text-ketchup uppercase">
                  save {formatCents(half.savingsCents)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <Perf label="Who are you" />

      {session.pending ? (
        <p className="font-body text-sm text-faded">Checking your sign-in…</p>
      ) : session.user === null ? (
        <>
          <p className="font-body text-sm leading-snug text-faded">
            Sign in so your bud knows who they are meeting, and so a split can be settled
            afterwards.
          </p>
          <button
            type="button"
            onClick={session.signIn}
            className="mt-4 w-full border-2 border-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] uppercase transition-transform active:translate-y-px"
          >
            Sign in with Google
          </button>
        </>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-display text-lg">{session.user.displayName}</span>
          <button
            type="button"
            onClick={() => {
              pool.leave()
              void session.signOut()
            }}
            className="font-display text-[0.65rem] tracking-[0.15em] text-faded uppercase underline"
          >
            Sign out
          </button>
        </div>
      )}

      {coords.notice !== null && (
        <p className="mt-4 font-body text-sm text-faded">{coords.notice}</p>
      )}
      {pool.error !== null && <p className="mt-4 font-body text-sm text-ketchup">{pool.error}</p>}

      <button
        type="button"
        disabled={!canStart}
        onClick={start}
        className="mt-6 w-full bg-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] text-paper uppercase transition-transform active:translate-y-px disabled:opacity-35"
      >
        {coords.pending ? 'Finding your cell…' : 'Find a bud'}
      </button>
      <p className="mt-3 font-body text-xs leading-snug text-faded">
        We use your location once, to find the pool for your block. Pairing fee is{' '}
        {formatCents(selected?.platformFeeCents ?? 99)} per split.
      </p>
    </Shell>
  )
}

function Shell({ cell, children }: { cell: string | null; children: React.ReactNode }) {
  return (
    <Roll>
      <header>
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="font-display text-xl font-bold tracking-[0.08em]">NUGGBUDZ</h1>
          <span className="font-display text-[0.6rem] tracking-[0.15em] text-faded uppercase">
            {cell === null ? 'no cell' : `cell ${cell}`}
          </span>
        </div>
        <p className="font-display text-[0.6rem] tracking-[0.22em] text-faded uppercase">
          Protein settlement layer
        </p>
      </header>
      <Perf />
      {children}
    </Roll>
  )
}

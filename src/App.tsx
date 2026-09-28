import type { DealSpec, Settlement, SpreadAnalysis } from '@shared/economics'
import { formatCents } from '@shared/economics'
import { formatMiles } from '@shared/geo'
import { describeLocationSource, type LocationSource } from '@shared/location'
import { saucesForMerchant } from '@shared/sauces'
import { useEffect, useState } from 'react'
import { RadiusMap } from './components/RadiusMap'
import { Line, Perf, Roll } from './components/Roll'
import { SaucePicker } from './components/SaucePicker'
import { SettlementReceipt } from './components/SettlementReceipt'
import { useCoords } from './hooks/useCoords'
import { usePool } from './hooks/usePool'
import { useSauces } from './hooks/useSauces'
import { useSession } from './hooks/useSession'

interface DealWithMath extends DealSpec {
  settlement: Settlement
  spread: SpreadAnalysis
}

const DEMO_NAME_KEY = 'nuggbudz.demoName'

function readStoredDemoName(): string {
  try {
    return localStorage.getItem(DEMO_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function App() {
  const [deals, setDeals] = useState<DealWithMath[]>([])
  const [dealId, setDealId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Null until `/api/health` answers; true when the server pairs without accounts. */
  const [demoPairing, setDemoPairing] = useState<boolean | null>(null)
  const [demoName, setDemoName] = useState(readStoredDemoName)

  const coords = useCoords()
  const pool = usePool()
  const session = useSession()
  // Signed in, and the pair lives on the account; not, and this browser is its
  // only home — which is the whole story for a demo buyer, who has no account.
  const sauces = useSauces(session.user !== null)

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

  // Whether this server pairs without accounts. Fails closed: if the probe does
  // not answer, assume sign-in is required rather than offering a name field the
  // server would reject.
  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((response) => response.json() as Promise<{ demoPairing?: boolean }>)
      .then((body) => {
        if (!cancelled) setDemoPairing(body.demoPairing === true)
      })
      .catch(() => {
        if (!cancelled) setDemoPairing(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** In demo mode an unauthenticated buyer pairs under a name they type. */
  const demoReady = demoPairing === true && session.user === null && demoName.trim().length > 0
  const identified = session.user !== null || demoReady

  /**
   * Take the seat. No location prompt: coordinates are sent only if the buyer
   * already turned on precise location, and the server places the socket from the
   * edge otherwise. Deliberately not an effect keyed on the fix — leaving the
   * queue would immediately rejoin on the still-set fix.
   */
  const start = () => {
    if (dealId === null || !identified) return
    pool.join({
      dealId,
      lat: coords.fix?.lat,
      lng: coords.fix?.lng,
      demoName: session.user === null ? demoName.trim() : undefined,
      // Only a finished pair goes up; the server validates it against the menu.
      sauces: sauces.selection ?? undefined,
    })
  }

  const selected = deals.find((deal) => deal.id === dealId) ?? null
  const canStart = identified && dealId !== null && !coords.pending
  const placement =
    pool.locationSource === null ? null : describeLocationSource(pool.locationSource)

  if (
    pool.match !== null &&
    (pool.stage === 'matched' || pool.stage === 'settled' || pool.stage === 'disputed')
  ) {
    return (
      <Shell radiusMeters={pool.radiusMeters} source={pool.locationSource}>
        <SettlementReceipt
          match={pool.match}
          yourSauces={sauces.selection}
          confirmed={pool.confirmed}
          waitingOn={pool.waitingOn}
          stage={pool.stage}
          notice={pool.notice}
          error={pool.error}
          chat={pool.chat}
          chatError={pool.chatError}
          onConfirm={pool.confirmPickup}
          onSendChat={pool.sendChat}
          onDone={pool.leave}
        />
      </Shell>
    )
  }

  if (pool.stage === 'connecting' || pool.stage === 'waiting') {
    const within = pool.radiusMeters === null ? null : formatMiles(pool.radiusMeters)
    return (
      <Shell radiusMeters={pool.radiusMeters} source={pool.locationSource}>
        <section aria-live="polite">
          <p className="font-display text-[0.65rem] tracking-[0.2em] text-faded uppercase">
            {pool.stage === 'connecting' ? 'Joining the pool' : 'Looking for a bud'}
          </p>
          <h2 className="caret mt-1 font-display text-2xl font-bold">
            {pool.stage === 'connecting' || within === null
              ? 'Standing in line'
              : `${pool.waiting} within ${within}`}
          </h2>

          {/* Drawn on every location rung, including the two that never involved
              a prompt: `welcome` carries the position the server actually used
              and the radius it is matching in, so there is always a centre and
              always a circle. The line under it says which rung that was, so a
              buyer on the demo origin is never told it is where they are. */}
          {pool.own !== null && pool.radiusMeters !== null && placement !== null && (
            <>
              <RadiusMap
                you={pool.own}
                radiusMeters={pool.radiusMeters}
                buddies={pool.buddies}
                centreLabel={placement.label}
              />
              <p className="mt-1 font-body text-xs leading-snug text-faded">{placement.detail}</p>
            </>
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
            {within === null
              ? 'You are paired the moment someone nearby wants the same box. Keep this open.'
              : `You are paired the moment someone within ${within} wants the same box. Keep this open.`}
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
    <Shell radiusMeters={pool.radiusMeters} source={pool.locationSource}>
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

      {selected !== null && (
        <>
          <Perf label="Sauce chart" />
          <SaucePicker
            sauces={saucesForMerchant(selected.merchant)}
            picks={sauces.picks}
            selection={sauces.selection}
            onTap={sauces.tap}
          />
        </>
      )}

      <Perf label="Who are you" />

      {session.pending ? (
        <p className="font-body text-sm text-faded">Checking your sign-in…</p>
      ) : session.user === null && demoPairing === true ? (
        <>
          <label className="block">
            <span className="font-display text-[0.65rem] tracking-[0.15em] text-faded uppercase">
              First name your bud will look for
            </span>
            <input
              value={demoName}
              onChange={(event) => {
                setDemoName(event.target.value)
                try {
                  localStorage.setItem(DEMO_NAME_KEY, event.target.value)
                } catch {
                  // A private window just means the name is not remembered.
                }
              }}
              maxLength={40}
              placeholder="e.g. Alex"
              className="mt-2 w-full border-b-2 border-ink bg-transparent px-1 py-2 font-display text-lg focus:outline-none"
            />
          </label>
          <p className="mt-3 font-body text-sm leading-snug text-faded">
            Demo mode: pairing without accounts. You will run the whole handoff and get a receipt,
            but the split is never booked to the ledger, and your bud only sees this name.
          </p>
        </>
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
        Find a bud
      </button>

      {/* The only control that may prompt for location, and nothing calls it for
          you. Pairing works whether or not it is ever tapped. */}
      {coords.fix === null ? (
        <button
          type="button"
          disabled={coords.pending}
          onClick={() => void coords.requestPrecise()}
          className="mt-3 w-full border-2 border-hairline px-4 py-3 font-display text-[0.7rem] font-bold tracking-[0.15em] uppercase transition-transform active:translate-y-px disabled:opacity-35"
        >
          {coords.pending ? 'Asking your device…' : 'Use my exact location'}
        </button>
      ) : (
        <p className="mt-3 font-body text-sm text-faded">
          Exact location on, so the walk to your bud is measured properly.
        </p>
      )}

      <p className="mt-3 font-body text-xs leading-snug text-faded">
        No permission prompt needed: we place you from your connection, which is accurate to about a
        neighbourhood. Pairing fee is {formatCents(selected?.platformFeeCents ?? 99)} per split.
      </p>
    </Shell>
  )
}

function Shell({
  radiusMeters,
  source,
  children,
}: {
  /** The market in force, as the server reported it; null before `welcome`. */
  radiusMeters: number | null
  /** Which rung placed this socket, once the server has said. */
  source: LocationSource | null
  children: React.ReactNode
}) {
  return (
    <Roll>
      <header>
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="font-display text-xl font-bold tracking-[0.08em]">NUGGBUDZ</h1>
          {/* The shard used to be printed here. It is not a thing a hungry
              person has a model for, and it stopped being what decides a match;
              the radius is both. */}
          <span className="font-display text-[0.6rem] tracking-[0.15em] text-faded uppercase">
            {radiusMeters === null ? 'not placed yet' : `within ${formatMiles(radiusMeters)}`}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-display text-[0.6rem] tracking-[0.22em] text-faded uppercase">
            Protein settlement layer
          </p>
          {source !== null && (
            <span className="font-display text-[0.6rem] tracking-[0.15em] text-faded uppercase">
              {describeLocationSource(source).label}
            </span>
          )}
        </div>
      </header>
      <Perf />
      {children}
    </Roll>
  )
}

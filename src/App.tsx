import type { DealSpec, Settlement, SpreadAnalysis } from '@shared/economics'
import { formatCents } from '@shared/economics'
import { formatMiles } from '@shared/geo'
import { describeLocationSource, type LocationSource } from '@shared/location'
import { saucesForMerchant } from '@shared/sauces'
import { useEffect, useState } from 'react'
import { HandoffCard } from './components/HandoffCard'
import { RadiusMap } from './components/RadiusMap'
import { RenderConsole } from './components/RenderConsole'
import { Line, Perf, Roll } from './components/Roll'
import { SaucePicker } from './components/SaucePicker'
import { SettlementReceipt } from './components/SettlementReceipt'
import { useCoords } from './hooks/useCoords'
import { useHandoff } from './hooks/useHandoff'
import { usePool } from './hooks/usePool'
import { useSauces } from './hooks/useSauces'
import { useSession } from './hooks/useSession'

interface DealWithMath extends DealSpec {
  settlement: Settlement
  spread: SpreadAnalysis
}

const DEMO_NAME_KEY = 'nuggbudz.demoName'

/**
 * How long a handoff link waits before deciding nobody claimed it.
 *
 * The server answers on the same round trip as `welcome`, so this is a
 * connection's worth of slack and not a retry budget. Erring long only delays a
 * fallback; erring short would print "this device is not in that match" at a
 * device that is.
 */
const HANDOFF_GRACE_MS = 2_000

function readStoredDemoName(): string {
  try {
    return localStorage.getItem(DEMO_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStoredDemoName(name: string): void {
  try {
    localStorage.setItem(DEMO_NAME_KEY, name)
  } catch {
    // A private window just means the name is not remembered.
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
  // Set only when this browser arrived on `/h/<code>` — a phone's own camera app
  // opening the QR on somebody's receipt.
  const handoff = useHandoff()
  /**
   * True until the server has had a moment to say whether it knows this browser
   * as half of a live handoff.
   *
   * There is no "you are in no match" message, and there should not be: the
   * server answers by *adopting* the socket at upgrade time or not, so the
   * absence is the answer. A short wait is what turns that absence into
   * something a screen can say, and it is bounded rather than a poll because the
   * answer rides the same round trip as `welcome`.
   */
  const [handoffResolving, setHandoffResolving] = useState(handoff.code !== null)
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

  /**
   * Arrived on a handoff link: open a socket and let the server decide whether
   * this browser is in that match.
   *
   * No coordinates, deliberately. The upgrade needs a shard, and the server
   * resolves one from the edge exactly as it does for a buyer who never answered
   * a location prompt — which is the same shard the first tab was placed in,
   * since the shard is ~156 km across. Prompting for a position here, on a
   * screen somebody reached by pointing a camera at a receipt, would be the
   * worst moment this app could pick to ask.
   */
  const attach = pool.attach
  useEffect(() => {
    if (handoff.code === null) return
    attach({ demoName: readStoredDemoName().trim() || undefined })
    const settle = window.setTimeout(() => setHandoffResolving(false), HANDOFF_GRACE_MS)
    return () => window.clearTimeout(settle)
  }, [handoff.code, attach])

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
    // Taking a seat is what makes a name and a pair worth remembering: this is
    // the pair a bud was promised and the name they will look for, so the next
    // visit opens on exactly what was queued with rather than on a half-edit.
    // The name is stored trimmed, the way it goes on the wire.
    writeStoredDemoName(demoName.trim())
    sauces.remember()
    pool.join({
      dealId,
      lat: coords.fix?.lat,
      lng: coords.fix?.lng,
      demoName: session.user === null ? demoName.trim() : undefined,
      // Only a finished pair goes up; the server validates it against the menu.
      sauces: sauces.selection ?? undefined,
    })
  }

  /**
   * Walk away from a match. Also forgets the handoff link that led here, if
   * there was one — otherwise leaving would drop straight back onto the screen
   * printing that code.
   */
  const leaveMatch = () => {
    handoff.dismiss()
    pool.leave()
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
      <Shell
        radiusMeters={pool.radiusMeters}
        source={pool.locationSource}
        render="resolved"
        buyers={pool.waiting}
        queuedAhead={pool.queuedAhead}
      >
        <SettlementReceipt
          match={pool.match}
          payment={pool.payment}
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
          onDone={leaveMatch}
          initialCode={handoff.code}
        />
      </Shell>
    )
  }

  // Reached only when the server did not recognise this browser as half of that
  // handoff, or has not answered yet. The code is still worth showing: reading
  // it out is the path the protocol was built on.
  if (handoff.code !== null) {
    return (
      <Shell radiusMeters={pool.radiusMeters} source={pool.locationSource}>
        <HandoffCard
          code={handoff.code}
          resolving={handoffResolving}
          onDismiss={() => {
            handoff.dismiss()
            pool.leave()
          }}
        />
      </Shell>
    )
  }

  if (pool.stage === 'connecting' || pool.stage === 'waiting') {
    const within = pool.radiusMeters === null ? null : formatMiles(pool.radiusMeters)
    return (
      <Shell
        radiusMeters={pool.radiusMeters}
        source={pool.locationSource}
        render="searching"
        buyers={pool.waiting}
        queuedAhead={pool.queuedAhead}
      >
        <section aria-live="polite">
          <p className="tag">
            {pool.stage === 'connecting' ? 'Joining the pool' : 'Looking for a bud'}
          </p>
          {/* The caret is a phosphor cursor, not part of the chrome fill: a
              block glyph rendered through the display gradient reads as a
              printing artefact rather than as a terminal waiting. */}
          <h2 className="mt-1 text-[2rem]">
            <span className="display">
              {pool.stage === 'connecting' || within === null
                ? 'Standing in line'
                : `${pool.waiting} within ${within}`}
            </span>
            <span className="caret text-phosphor" aria-hidden="true" />
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
              <p className="mt-1 font-body text-xs leading-snug text-steel">{placement.detail}</p>
            </>
          )}

          <Perf label={selected?.merchant ?? 'Deal'} />

          <Line label="Your order" value={selected?.label ?? '—'} />
          <Line
            label="Your half"
            value={formatCents(selected?.settlement.shares[1]?.payCents ?? 0)}
            emphasis="total"
          />

          {pool.notice !== null && (
            <p className="mt-4 font-body text-sm text-ketchup">{pool.notice}</p>
          )}

          <p className="mt-4 font-body text-sm leading-snug text-steel">
            {within === null
              ? 'You are paired the moment someone nearby wants the same box. Keep this open.'
              : `You are paired the moment someone within ${within} wants the same box. Keep this open.`}
          </p>

          <button type="button" onClick={pool.leave} className="btn btn-outline mt-7">
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
              className="chip"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[0.7rem] tracking-[0.12em] text-chrome uppercase">
                  {deal.merchant}
                </span>
                <span className="font-mono text-base font-bold text-nugget tabular-nums">
                  {formatCents(half.payCents)}
                </span>
              </span>
              <span className="mt-1 flex items-baseline justify-between gap-2">
                <span className="font-body text-sm text-steel">{deal.label}</span>
                <span className="font-mono text-[0.65rem] tracking-[0.1em] text-ketchup uppercase">
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
        <p className="font-body text-sm text-steel">Checking your sign-in…</p>
      ) : session.user === null && demoPairing === true ? (
        <>
          <label className="block">
            <span className="tag">First name your bud will look for</span>
            <input
              value={demoName}
              onChange={(event) => {
                setDemoName(event.target.value)
                // Also written as it is typed, so a reload before joining does not
                // lose it; joining re-stamps the trimmed name it actually used.
                writeStoredDemoName(event.target.value)
              }}
              maxLength={40}
              placeholder="e.g. Alex"
              className="slot mt-2 text-lg"
            />
          </label>
          <p className="mt-3 font-body text-sm leading-snug text-steel">
            Demo mode: pairing without accounts. You will run the whole handoff and get a receipt,
            but the split is never booked to the ledger, and your bud only sees this name.
          </p>
        </>
      ) : session.user === null ? (
        <>
          <p className="font-body text-sm leading-snug text-steel">
            Sign in so your bud knows who they are meeting, and so a split can be settled
            afterwards.
          </p>
          <button type="button" onClick={session.signIn} className="btn btn-outline mt-4">
            Sign in with Google
          </button>
        </>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-lg text-chrome">{session.user.displayName}</span>
          <button
            type="button"
            onClick={() => {
              pool.leave()
              void session.signOut()
            }}
            className="btn-plain w-auto"
          >
            Sign out
          </button>
        </div>
      )}

      {coords.notice !== null && (
        <p className="mt-4 font-body text-sm text-steel">{coords.notice}</p>
      )}
      {pool.error !== null && <p className="mt-4 font-body text-sm text-ketchup">{pool.error}</p>}

      <button type="button" disabled={!canStart} onClick={start} className="btn btn-chrome mt-6">
        Find a bud
      </button>

      {/* The only control that may prompt for location, and nothing calls it for
          you. Pairing works whether or not it is ever tapped. */}
      {coords.fix === null ? (
        <button
          type="button"
          disabled={coords.pending}
          onClick={() => void coords.requestPrecise()}
          className="btn btn-outline mt-3 py-3 text-[0.7rem]"
        >
          {coords.pending ? 'Asking your device…' : 'Use my exact location'}
        </button>
      ) : (
        <p className="mt-3 font-body text-sm text-steel">
          Exact location on, so the walk to your bud is measured properly.
        </p>
      )}

      <p className="mt-3 font-body text-xs leading-snug text-steel">
        No permission prompt needed: we place you from your connection, which is accurate to about a
        neighbourhood. Pairing fee is {formatCents(selected?.platformFeeCents ?? 99)} per split.
      </p>
    </Shell>
  )
}

function Shell({
  radiusMeters,
  source,
  render = 'none',
  buyers = 0,
  queuedAhead = 0,
  children,
}: {
  /** The market in force, as the server reported it; null before `welcome`. */
  radiusMeters: number | null
  /** Which rung placed this socket, once the server has said. */
  source: LocationSource | null
  /**
   * Whether the render is running, and what it is doing.
   *
   * It lives here rather than inside a screen so that pairing does not unmount
   * it: the canvas keeps its frame counter across the move from the queue to
   * the receipt, which is what lets the turn decelerate into a pose instead of
   * being replaced by a different picture.
   */
  render?: 'none' | 'searching' | 'resolved'
  /** Buyers waiting inside your radius, for the readout. */
  buyers?: number
  queuedAhead?: number
  children: React.ReactNode
}) {
  return (
    <Roll>
      <header>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="display text-[2.05rem] tracking-[0.01em]">NUGGBUDZ</h1>
          {/* The shard used to be printed here. It is not a thing a hungry
              person has a model for, and it stopped being what decides a match;
              the radius is both. */}
          <span className="tag shrink-0">
            {radiusMeters === null ? 'not placed yet' : `within ${formatMiles(radiusMeters)}`}
          </span>
        </div>
        {/* Two badges that are each too long to share a 256px line with the
            other. Wrapping is the honest answer: the second drops to its own
            line and stays right-aligned rather than being truncated. */}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
          <p className="tag">Protein settlement layer</p>
          {source !== null && (
            <span className="tag ml-auto">{describeLocationSource(source).label}</span>
          )}
        </div>
      </header>

      {render !== 'none' && (
        <div className="mt-4">
          <RenderConsole
            resolved={render === 'resolved'}
            buyers={buyers}
            queuedAhead={queuedAhead}
            radiusMeters={radiusMeters}
          />
        </div>
      )}

      <Perf />
      {children}
    </Roll>
  )
}

import { type BuyerRole, formatCents } from '@shared/economics'
import type { LocationSource } from '@shared/location'
import type {
  CellBuddy,
  MatchedMessage,
  PaymentRequiredMessage,
  ServerMessage,
} from '@shared/protocol'
import type { SauceSelection } from '@shared/sauces'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PoolStage = 'idle' | 'connecting' | 'waiting' | 'matched' | 'settled' | 'disputed'

/** Stages where the socket has done its job and a close is not an error. */
const TERMINAL: readonly PoolStage[] = ['matched', 'settled', 'disputed']

export interface JoinRequest {
  dealId: string
  /**
   * Precise coordinates, sent only when the buyer turned on exact location.
   * Leaving them out is the normal case and never prompts: the server places the
   * socket from the edge instead, and reports which rung it used.
   */
  lat?: number
  lng?: number
  /**
   * A name to pair under when the server is in demo mode and nobody is signed
   * in. Ignored whenever a session exists — the server takes the display name
   * off the session, so this can never rename a real account.
   */
  demoName?: string
  /**
   * The two sauces this buyer wants, when they picked a pair. The server checks
   * them against the catalogue and refuses a pair it does not recognise, so this
   * is a request rather than a fact.
   */
  sauces?: SauceSelection
}

export interface PoolState {
  stage: PoolStage
  /** Buyers queued in your cell on your deal, including you. */
  waiting: number
  queuedAhead: number
  cell: string | null
  /** Which rung of the location fallback placed this socket; null until welcomed. */
  locationSource: LocationSource | null
  /**
   * Where you told the server you are standing, when you told it at all. Kept
   * around (not just handed off to `join` and discarded) so the cell map has a
   * "you are here" marker to draw at full precision — the server only ever
   * coarsens *other* buyers' positions, since this one is already yours. Null on
   * the no-prompt path, where only the server knows where you are.
   */
  own: { lat: number; lng: number } | null
  /** Everyone else waiting in your cell, snapped to a coarse grid server-side. */
  buddies: CellBuddy[]
  match: MatchedMessage | null
  /**
   * The charge for your half, once the server has opened it with Stripe. Null
   * both before there is anything to pay and after both halves have cleared — the
   * pickup code arriving on `payment_cleared` is what retires it.
   */
  payment: PaymentRequiredMessage | null
  error: string | null
  /**
   * Set when something happened to your seat that you did not ask for: a buddy
   * walked away, your entry went stale, or a match was never confirmed.
   */
  notice: string | null
  /** Sides of the handoff confirmed so far. */
  confirmed: BuyerRole[]
  /** The side still owing a confirmation, while the handshake is half done. */
  waitingOn: BuyerRole | null
}

const INITIAL: PoolState = {
  stage: 'idle',
  waiting: 0,
  queuedAhead: 0,
  cell: null,
  locationSource: null,
  own: null,
  buddies: [],
  match: null,
  payment: null,
  error: null,
  notice: null,
  confirmed: [],
  waitingOn: null,
}

/**
 * Say a server-supplied window in units a hungry person reads.
 *
 * The windows are configurable, so this cannot assume minutes: a dev server runs
 * them in seconds to make the expiry path observable.
 */
function humanWindow(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const mins = Math.round(seconds / 60)
  return `${mins} minute${mins === 1 ? '' : 's'}`
}

/**
 * What to append to a teardown notice when money was collected and not returned.
 *
 * A refund the processor refused is not a refund, and the screen must not imply
 * one. Empty in the ordinary case, so the common path reads exactly as before.
 */
function heldSuffix(heldCents: number): string {
  if (heldCents <= 0) return ''
  return ` ${formatCents(heldCents)} could not be refunded automatically and is being held — flagged for a human.`
}

function socketUrl({ lat, lng, demoName }: JoinRequest): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams()
  // Sent only on the opt-in precise path. With no coordinates the server falls
  // back to the edge's approximate location, which is why pairing needs no
  // permission prompt at all.
  if (lat !== undefined && lng !== undefined) {
    params.set('lat', String(lat))
    params.set('lng', String(lng))
  }
  // Only meaningful in demo mode; the server ignores it whenever a session
  // exists, and sanitizes it when one does not.
  if (demoName !== undefined && demoName.trim().length > 0) {
    params.set('name', demoName.trim())
  }
  return `${scheme}://${window.location.host}/api/pool/ws?${params}`
}

/**
 * Hold a live seat in a neighbourhood's matching pool.
 *
 * One socket per session. The server decides which cell you belong to, where it
 * thinks you are standing, and — from your session cookie — who you are. So the
 * only thing this hook has to send up is which box it wants.
 */
export function usePool() {
  const [state, setState] = useState<PoolState>(INITIAL)
  const socketRef = useRef<WebSocket | null>(null)
  const keepaliveRef = useRef<number | null>(null)

  const stopKeepalive = useCallback(() => {
    if (keepaliveRef.current !== null) window.clearInterval(keepaliveRef.current)
    keepaliveRef.current = null
  }, [])

  /**
   * Ping well inside the server's idle window.
   *
   * The server drops a queue entry that goes quiet, and waiting is the whole
   * point of the queue — so without this the normal case, a buyer sitting on the
   * page, would be aged out of their own market.
   */
  const startKeepalive = useCallback(
    (socket: WebSocket, queueIdleMs: number) => {
      stopKeepalive()
      const every = Math.max(5_000, Math.floor(queueIdleMs / 3))
      keepaliveRef.current = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: 'ping', at: Date.now() }))
      }, every)
    },
    [stopKeepalive],
  )

  const close = useCallback(() => {
    stopKeepalive()
    const socket = socketRef.current
    socketRef.current = null
    if (socket !== null) {
      socket.onclose = null
      socket.close()
    }
  }, [stopKeepalive])

  // Never leave a socket open behind an unmounted tree.
  useEffect(() => close, [close])

  const leave = useCallback(() => {
    close()
    setState(INITIAL)
  }, [close])

  const join = useCallback(
    (request: JoinRequest) => {
      close()
      const own =
        request.lat !== undefined && request.lng !== undefined
          ? { lat: request.lat, lng: request.lng }
          : null
      setState({ ...INITIAL, stage: 'connecting', own })

      const socket = new WebSocket(socketUrl(request))
      socketRef.current = socket

      socket.onopen = () => {
        // Coordinates are omitted unless the buyer opted into precise location:
        // the socket already carries a server-resolved one. Sauces are omitted
        // until a pair is complete — half a choice is not a selection.
        const payload: Record<string, unknown> = { type: 'join', dealId: request.dealId }
        if (request.lat !== undefined && request.lng !== undefined) {
          payload.lat = request.lat
          payload.lng = request.lng
        }
        if (request.sauces !== undefined) payload.sauces = request.sauces
        socket.send(JSON.stringify(payload))
      }

      socket.onmessage = (event) => {
        let message: ServerMessage
        try {
          message = JSON.parse(String(event.data)) as ServerMessage
        } catch {
          return
        }

        if (message.type === 'welcome') startKeepalive(socket, message.expiry.queueIdleMs)

        setState((prev) => {
          switch (message.type) {
            case 'welcome':
              return {
                ...prev,
                cell: message.cell,
                locationSource: message.locationSource,
                waiting: message.waiting,
              }
            case 'waiting':
              return {
                ...prev,
                stage: 'waiting',
                waiting: message.waiting,
                queuedAhead: message.queuedAhead,
                buddies: message.buddies,
              }
            case 'matched':
              return {
                ...prev,
                stage: 'matched',
                match: message,
                payment: null,
                notice: null,
                confirmed: [],
                waitingOn: null,
              }
            case 'payment_required':
              return { ...prev, payment: message, error: null }
            case 'payment_cleared':
              // The code lands on the match rather than in a field of its own, so
              // every screen keeps reading one place for it — and for the receiver
              // it is still null, exactly as it was on `matched`.
              return {
                ...prev,
                payment: null,
                match:
                  prev.match === null ? null : { ...prev.match, pickupCode: message.pickupCode },
              }
            case 'payment_failed':
              return {
                ...prev,
                // Requeued only if it was your bud who failed; if it was you, the
                // server took you off the queue and you have to ask again.
                stage: message.whose === 'you' ? 'idle' : 'waiting',
                match: null,
                payment: null,
                confirmed: [],
                waitingOn: null,
                notice:
                  message.whose === 'you'
                    ? `Your payment did not go through, so that match is off.${heldSuffix(message.heldCents)}`
                    : `Your bud's payment failed${
                        message.refunded ? ` — ${formatCents(message.refundedCents)} refunded` : ''
                      }. Back in the queue.${heldSuffix(message.heldCents)}`,
              }
            case 'buddy_left':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
                payment: null,
                notice: 'Your bud dropped out. Back in the queue.',
              }
            case 'pickup_confirmed':
              return {
                ...prev,
                error: null,
                confirmed: prev.confirmed.includes(message.by)
                  ? prev.confirmed
                  : [...prev.confirmed, message.by],
                waitingOn: message.waitingOn,
              }
            case 'pickup_complete':
              return { ...prev, stage: 'settled', waitingOn: null, error: null }
            case 'pickup_disputed':
              return {
                ...prev,
                stage: 'disputed',
                waitingOn: null,
                notice: `${
                  message.reason === 'buddy_left'
                    ? 'Your bud left before confirming.'
                    : 'Only one of you confirmed in time.'
                } This split is flagged for review${
                  // A dispute holds the money on purpose — see README's "A
                  // disputed split holds the money". Saying "flagged for review"
                  // without saying that leaves a buyer who paid assuming a
                  // refund is on its way.
                  message.heldCents > 0
                    ? `, and ${formatCents(message.heldCents)} is held until someone looks at it`
                    : ''
                }.`,
              }
            case 'queue_expiring':
              return {
                ...prev,
                notice: `Still hungry? Your spot goes away in ${humanWindow(message.expiresAt - Date.now())}.`,
              }
            case 'queue_expired':
              return {
                ...prev,
                stage: 'idle',
                waiting: 0,
                queuedAhead: 0,
                // No longer in the market, so the cell's dots are not yours to show.
                buddies: [],
                notice: `Dropped from the queue after ${humanWindow(message.idleMs)} of quiet. Join again when you are ready.`,
              }
            case 'match_expired':
              return {
                ...prev,
                stage: 'idle',
                match: null,
                payment: null,
                // Never confirmed by either side, so there is no half-done
                // handshake to keep on screen — that is the disputed stage.
                confirmed: [],
                waitingOn: null,
                // Says what happened to the money rather than assuming: with
                // payments live, a match called off after both halves cleared has
                // real cents to give back.
                notice:
                  message.refundedCents > 0
                    ? `That match went unconfirmed and was called off. ${formatCents(message.refundedCents)} refunded.${heldSuffix(message.heldCents)}`
                    : `That match went unconfirmed and was called off.${
                        message.heldCents > 0 ? '' : ' Nothing was charged.'
                      }${heldSuffix(message.heldCents)}`,
              }
            case 'error':
              return { ...prev, error: message.message }
            default:
              return prev
          }
        })
      }

      socket.onclose = () => {
        if (socketRef.current !== socket) return
        socketRef.current = null
        stopKeepalive()
        setState((prev) =>
          TERMINAL.includes(prev.stage)
            ? prev
            : { ...prev, stage: 'idle', error: 'Lost the connection. Try again.' },
        )
      }
    },
    [close, startKeepalive, stopKeepalive],
  )

  /**
   * Say the handoff happened. The receiver sends the code off their bud's
   * receipt; the orderer sends nothing, because they are the receipt.
   */
  const confirmPickup = useCallback((code?: string) => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'confirm_pickup', code: code ?? null }))
  }, [])

  return { ...state, join, leave, confirmPickup }
}

import type { BuyerRole } from '@shared/economics'
import type { CellBuddy, MatchedMessage, ServerMessage } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PoolStage = 'idle' | 'connecting' | 'waiting' | 'matched' | 'settled' | 'disputed'

/** Stages where the socket has done its job and a close is not an error. */
const TERMINAL: readonly PoolStage[] = ['matched', 'settled', 'disputed']

export interface JoinRequest {
  dealId: string
  lat: number
  lng: number
}

export interface PoolState {
  stage: PoolStage
  /** Buyers queued in your cell on your deal, including you. */
  waiting: number
  queuedAhead: number
  cell: string | null
  /**
   * Where you told the server you are standing. Kept around (not just handed
   * off to `join` and discarded) so the cell map has a "you are here" marker
   * to draw at full precision — the server only ever coarsens *other*
   * buyers' positions, since this one is already yours.
   */
  own: { lat: number; lng: number } | null
  /** Everyone else waiting in your cell, snapped to a coarse grid server-side. */
  buddies: CellBuddy[]
  match: MatchedMessage | null
  error: string | null
  /** Set when a buddy walked away and you were put back in the queue. */
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
  own: null,
  buddies: [],
  match: null,
  error: null,
  notice: null,
  confirmed: [],
  waitingOn: null,
}

function socketUrl({ lat, lng }: JoinRequest): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) })
  return `${scheme}://${window.location.host}/api/pool/ws?${params}`
}

/**
 * Hold a live seat in a neighbourhood's matching pool.
 *
 * One socket per session. The server decides which cell you belong to and, from
 * your session cookie, who you are — so the only thing this hook sends up is
 * what you want and where you are standing.
 */
export function usePool() {
  const [state, setState] = useState<PoolState>(INITIAL)
  const socketRef = useRef<WebSocket | null>(null)

  const close = useCallback(() => {
    const socket = socketRef.current
    socketRef.current = null
    if (socket !== null) {
      socket.onclose = null
      socket.close()
    }
  }, [])

  // Never leave a socket open behind an unmounted tree.
  useEffect(() => close, [close])

  const leave = useCallback(() => {
    close()
    setState(INITIAL)
  }, [close])

  const join = useCallback(
    (request: JoinRequest) => {
      close()
      setState({ ...INITIAL, stage: 'connecting', own: { lat: request.lat, lng: request.lng } })

      const socket = new WebSocket(socketUrl(request))
      socketRef.current = socket

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'join',
            dealId: request.dealId,
            lat: request.lat,
            lng: request.lng,
          }),
        )
      }

      socket.onmessage = (event) => {
        let message: ServerMessage
        try {
          message = JSON.parse(String(event.data)) as ServerMessage
        } catch {
          return
        }

        setState((prev) => {
          switch (message.type) {
            case 'welcome':
              return { ...prev, cell: message.cell, waiting: message.waiting }
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
                notice: null,
                confirmed: [],
                waitingOn: null,
              }
            case 'buddy_left':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
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
                notice:
                  message.reason === 'buddy_left'
                    ? 'Your bud left before confirming. This split is flagged for review.'
                    : 'Only one of you confirmed in time. This split is flagged for review.',
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
        setState((prev) =>
          TERMINAL.includes(prev.stage)
            ? prev
            : { ...prev, stage: 'idle', error: 'Lost the connection. Try again.' },
        )
      }
    },
    [close],
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

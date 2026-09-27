import type { MatchedMessage, PaymentRequiredMessage, ServerMessage } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * `matched` is paired-and-owing; `cleared` is both halves paid. Only the
 * second one has a pickup code, and it is the server that says which you are
 * in — the client cannot promote itself.
 */
export type PoolStage = 'idle' | 'connecting' | 'waiting' | 'matched' | 'cleared'

export interface JoinRequest {
  name: string
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
  match: MatchedMessage | null
  /** The charge for your half, once the server has opened it with Stripe. */
  payment: PaymentRequiredMessage | null
  /**
   * Issued by the server only once both halves have cleared. Null means there
   * is no pickup code to show, which is the whole point: the UI cannot render
   * one it was never given.
   */
  pickupCode: string | null
  error: string | null
  /** Set when a buddy walked away and you were put back in the queue. */
  notice: string | null
}

const INITIAL: PoolState = {
  stage: 'idle',
  waiting: 0,
  queuedAhead: 0,
  cell: null,
  match: null,
  payment: null,
  pickupCode: null,
  error: null,
  notice: null,
}

function socketUrl({ lat, lng }: JoinRequest): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) })
  return `${scheme}://${window.location.host}/api/pool/ws?${params}`
}

/**
 * Hold a live seat in a neighbourhood's matching pool.
 *
 * One socket per session. The server decides which cell you belong to, so the
 * only thing this hook sends up is who you are, what you want, and where you
 * are standing.
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
      setState({ ...INITIAL, stage: 'connecting' })

      const socket = new WebSocket(socketUrl(request))
      socketRef.current = socket

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'join',
            name: request.name,
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
              }
            case 'matched':
              return {
                ...prev,
                stage: 'matched',
                match: message,
                payment: null,
                pickupCode: null,
                notice: null,
              }
            case 'payment_required':
              return { ...prev, payment: message }
            case 'payment_cleared':
              return { ...prev, stage: 'cleared', pickupCode: message.pickupCode }
            case 'payment_failed':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
                payment: null,
                pickupCode: null,
                notice:
                  message.whose === 'you'
                    ? 'Your payment did not go through. Back in the queue.'
                    : `Your bud's payment failed${
                        message.refunded ? ' — your half was refunded' : ''
                      }. Back in the queue.`,
              }
            case 'buddy_left':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
                payment: null,
                pickupCode: null,
                notice: 'Your bud dropped out. Back in the queue.',
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
          prev.stage === 'matched' || prev.stage === 'cleared'
            ? prev
            : { ...prev, stage: 'idle', error: 'Lost the connection. Try again.' },
        )
      }
    },
    [close],
  )

  return { ...state, join, leave }
}

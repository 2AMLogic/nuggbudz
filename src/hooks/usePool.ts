import type { MatchedMessage, ServerMessage } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PoolStage = 'idle' | 'connecting' | 'waiting' | 'matched'

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
  match: MatchedMessage | null
  error: string | null
  /**
   * Set when something happened to your seat that you did not ask for: a buddy
   * walked away, your entry went stale, or a match was never confirmed.
   */
  notice: string | null
}

const INITIAL: PoolState = {
  stage: 'idle',
  waiting: 0,
  queuedAhead: 0,
  cell: null,
  match: null,
  error: null,
  notice: null,
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
      setState({ ...INITIAL, stage: 'connecting' })

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

        if (message.type === 'welcome') startKeepalive(socket, message.expiry.queueIdleMs)

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
              return { ...prev, stage: 'matched', match: message, notice: null }
            case 'buddy_left':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
                notice: 'Your bud dropped out. Back in the queue.',
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
                notice: `Dropped from the queue after ${humanWindow(message.idleMs)} of quiet. Join again when you are ready.`,
              }
            case 'match_expired':
              return {
                ...prev,
                stage: 'idle',
                match: null,
                notice: 'That match went unconfirmed and was called off. Nothing was charged.',
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
          prev.stage === 'matched'
            ? prev
            : { ...prev, stage: 'idle', error: 'Lost the connection. Try again.' },
        )
      }
    },
    [close, startKeepalive, stopKeepalive],
  )

  return { ...state, join, leave }
}

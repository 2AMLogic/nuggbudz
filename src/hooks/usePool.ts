import type { MatchedMessage, ServerMessage } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PoolStage = 'idle' | 'connecting' | 'waiting' | 'matched'

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
              return { ...prev, stage: 'matched', match: message, notice: null }
            case 'buddy_left':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
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
          prev.stage === 'matched'
            ? prev
            : { ...prev, stage: 'idle', error: 'Lost the connection. Try again.' },
        )
      }
    },
    [close],
  )

  return { ...state, join, leave }
}

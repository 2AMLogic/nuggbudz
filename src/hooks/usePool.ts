import { isChatErrorCode, MAX_CHAT_HISTORY } from '@shared/chat'
import { type BuyerRole, formatCents } from '@shared/economics'
import type { LocationSource } from '@shared/location'
import type {
  ChatRelayMessage,
  MarketMessage,
  MatchedMessage,
  PaymentRequiredMessage,
  RadiusBuddy,
  ServerMessage,
} from '@shared/protocol'
import type { SauceSelection } from '@shared/sauces'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PoolStage = 'idle' | 'connecting' | 'waiting' | 'matched' | 'settled' | 'disputed'

/**
 * One relayed message, plus a local sequence number.
 *
 * The server's `at` is a millisecond timestamp and two messages can share one,
 * so it is not a key. `seq` is assigned on arrival and never leaves this tab —
 * it is not part of the protocol and is not an id anything could look a message
 * up by, because there is nowhere to look one up.
 */
export interface ChatLine extends ChatRelayMessage {
  seq: number
}

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
  /** Buyers queued within your radius on your deal, including you. */
  waiting: number
  queuedAhead: number
  /** Which rung of the location fallback placed this socket; null until welcomed. */
  locationSource: LocationSource | null
  /**
   * Where the server placed this socket, read off `welcome` — not out of the
   * join request.
   *
   * The server always knows this, on every rung, so taking it from there is what
   * lets the map have a centre even when the buyer never answered a permission
   * prompt. Taking it from the *request* instead would have been null exactly on
   * the promptless path, which is the common one. Null only until the socket is
   * welcomed.
   */
  own: { lat: number; lng: number } | null
  /**
   * How far a buddy may be and still be matched with you, in metres, as the
   * server reports it. Null until welcomed; never a literal in this app.
   */
  radiusMeters: number | null
  /** Everyone else waiting within your radius, snapped to a coarse grid server-side. */
  buddies: RadiusBuddy[]
  /**
   * The market around a socket that holds no seat: how many are queued within
   * your radius, overall and per deal. Counts only — the server sends no roster
   * to a socket without a seat (#150). Null until a socket has been welcomed.
   */
  market: Pick<MarketMessage, 'waiting' | 'byDeal'> | null
  /**
   * The server refused a seat because this browser is not signed in (#150).
   *
   * Set from the refusal on the wire, never guessed here: whether an anonymous
   * browser may take a seat is the server's one decision (`seatVerdict`), and a
   * client that decided it for itself would be a second answer to drift from
   * the first. Cleared by `dismissSignIn`, or by any new connection.
   */
  signInRequired: boolean
  match: MatchedMessage | null
  /**
   * The charge for your half, once the server has opened it with Stripe. Null
   * both before there is anything to pay and after both halves have cleared — the
   * pickup code arriving on `payment_cleared` is what retires it.
   */
  payment: PaymentRequiredMessage | null
  error: string | null
  /**
   * Why the last line you tried to say was refused, shown under the chat input.
   *
   * Separate from `error` because the matched screen renders the two in different
   * places, and cleared as soon as a line of yours does get through — a "wait 10s"
   * that outlives the wait is worse than no message at all.
   */
  chatError: string | null
  /**
   * Set when something happened to your seat that you did not ask for: a buddy
   * walked away, your entry went stale, or a match was never confirmed.
   */
  notice: string | null
  /** Sides of the handoff confirmed so far. */
  confirmed: BuyerRole[]
  /** The side still owing a confirmation, while the handshake is half done. */
  waitingOn: BuyerRole | null
  /**
   * The live conversation with your bud, in arrival order.
   *
   * Held in React state and nowhere else — not localStorage, not a ref that
   * outlives the match. The server keeps no copy either, so this array *is* the
   * conversation and emptying it is the conversation ending. It is cleared the
   * moment the match does, which is what makes the line on screen true.
   */
  chat: ChatLine[]
}

const INITIAL: PoolState = {
  stage: 'idle',
  waiting: 0,
  queuedAhead: 0,
  locationSource: null,
  own: null,
  radiusMeters: null,
  buddies: [],
  market: null,
  signInRequired: false,
  match: null,
  payment: null,
  error: null,
  chatError: null,
  notice: null,
  confirmed: [],
  waitingOn: null,
  chat: [],
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

/**
 * What the upgrade itself needs: where you are, and what to call you in demo
 * mode. Which box you want is a message, not a connection parameter.
 */
export type SocketRequest = Pick<JoinRequest, 'lat' | 'lng' | 'demoName'>

function socketUrl({ lat, lng, demoName }: SocketRequest): string {
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
 * One socket per session. The server decides where it thinks you are standing,
 * how far a buddy may be, and — from your session cookie — who you are. So the
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

  /**
   * Open the socket. `queue` says whether to ask for a seat once it is up.
   *
   * The two callers want the same connection for different reasons: `join` wants
   * a place in the queue, and `attach` (#101) wants only to be seen — a phone
   * that just opened a handoff link needs to find out whether the server already
   * knows it as half of a live match. The server answers that at upgrade time,
   * before any client message, so `attach` sends nothing at all.
   */
  const connect = useCallback(
    (request: SocketRequest, seat: JoinRequest | null) => {
      close()
      // No optimistic position here: `welcome` carries the one the server
      // actually used, which is the only one the radius on the map is true for.
      // A socket that is not asking for a seat stays `idle`: it is looking at
      // the market, not standing in line for it.
      setState({ ...INITIAL, stage: seat === null ? 'idle' : 'connecting' })

      const socket = new WebSocket(socketUrl(request))
      socketRef.current = socket

      socket.onopen = () => {
        if (seat === null) return
        // Coordinates are omitted unless the buyer opted into precise location:
        // the socket already carries a server-resolved one. Sauces are omitted
        // until a pair is complete — half a choice is not a selection.
        const payload: Record<string, unknown> = { type: 'join', dealId: seat.dealId }
        if (seat.lat !== undefined && seat.lng !== undefined) {
          payload.lat = seat.lat
          payload.lng = seat.lng
        }
        if (seat.sauces !== undefined) payload.sauces = seat.sauces
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
                locationSource: message.locationSource,
                own: message.position,
                radiusMeters: message.radiusMeters,
                // `marketWaiting` is deliberately not written to `waiting`: that
                // slot is one deal's queue including you, and the market figure
                // arrives on its own in the `market` frame right behind this.
              }
            case 'market':
              return { ...prev, market: { waiting: message.waiting, byDeal: message.byDeal } }
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
                // A new match starts with an empty conversation. Nothing carries
                // over from the last one, here or on the server.
                chat: [],
                // Nor does a refusal earned in the last one.
                chatError: null,
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
                // A dead match takes its conversation with it.
                chat: [],
                chatError: null,
              }
            case 'chat_message': {
              const line: ChatLine = { ...message, seq: (prev.chat.at(-1)?.seq ?? 0) + 1 }
              // Bounded, so a long wait at the counter cannot grow this without
              // limit. Dropping the oldest line loses nothing that was ever
              // stored anywhere.
              return {
                ...prev,
                chat: [...prev.chat, line].slice(-MAX_CHAT_HISTORY),
                // The server echoes your own line back, so this is the one signal
                // that a send of *yours* got through: clear the refusal. A line
                // from your bud clears nothing — a rate limit is yours alone and
                // their reply arriving does not mean your wait is over.
                chatError: message.from === prev.match?.role ? null : prev.chatError,
              }
            }
            case 'buddy_left':
              return {
                ...prev,
                stage: 'waiting',
                match: null,
                payment: null,
                notice: `Your bud dropped out. Back in the queue.${heldSuffix(message.heldCents)}`,
                // Their half of the conversation left with them.
                chat: [],
                chatError: null,
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
              // The receipt stays; the conversation does not. This is the moment
              // the screen promised it would disappear, and it is the same moment
              // the server stops relaying.
              return {
                ...prev,
                stage: 'settled',
                waitingOn: null,
                error: null,
                chat: [],
                chatError: null,
              }
            case 'pickup_disputed':
              return {
                ...prev,
                stage: 'disputed',
                waitingOn: null,
                chat: [],
                chatError: null,
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
                // No longer in the market, so the dots are not yours to show.
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
                chat: [],
                chatError: null,
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
              // The seat was refused for want of an account. Not an error to
              // print: it is the moment to offer the sign-in, and the socket
              // stays open, idle, still showing the market.
              if (message.code === 'sign_in_required') {
                return { ...prev, stage: 'idle', signInRequired: true, error: null }
              }
              // Two surfaces, one socket: the code decides which one hears about
              // it, so a mistyped pickup code is never reported as a chat problem.
              return isChatErrorCode(message.code)
                ? { ...prev, chatError: message.message }
                : { ...prev, error: message.message }
            default:
              return prev
          }
        })
      }

      socket.onclose = () => {
        if (socketRef.current !== socket) return
        socketRef.current = null
        stopKeepalive()
        setState((prev) => {
          if (TERMINAL.includes(prev.stage)) return prev
          // A socket that only ever looked at the market has nothing to report
          // losing: the counts go, and the landing screen carries on without
          // them. A refused browse upgrade — a rate limit, say — must not greet
          // a visitor with an error about a seat they never asked for.
          if (seat === null) return { ...prev, stage: 'idle', market: null }
          return { ...prev, stage: 'idle', error: 'Lost the connection. Try again.' }
        })
      }
    },
    [close, startKeepalive, stopKeepalive],
  )

  const join = useCallback((request: JoinRequest) => connect(request, request), [connect])

  /**
   * Open a socket without asking for a seat.
   *
   * The one caller is a browser that just opened a handoff link. If the server
   * already holds a released handoff for this identity it says so immediately,
   * with the same `matched` the first tab got, and the receipt appears here too;
   * if it does not, this socket simply sits idle and the screen falls back to
   * showing the code to read and type. Nothing about it confirms anything —
   * confirming is still a tap, and the server still checks the code and the role.
   */
  const attach = useCallback((request: SocketRequest) => connect(request, null), [connect])

  /** Put the sign-in interstitial away without signing in. The socket stays. */
  const dismissSignIn = useCallback(() => {
    setState((prev) => ({ ...prev, signInRequired: false }))
  }, [])

  /**
   * Say the handoff happened. The receiver sends the code off their bud's
   * receipt; the orderer sends nothing, because they are the receipt.
   */
  const confirmPickup = useCallback((code?: string) => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'confirm_pickup', code: code ?? null }))
  }, [])

  /**
   * Say something to your bud.
   *
   * Sent raw: sanitizing here would only decide what *this* screen shows, and the
   * text a stranger reads has to be cleaned by the server that relays it. The
   * line comes back on the socket like any other, so nothing is added to `chat`
   * optimistically and both buddies see identical text.
   */
  const sendChat = useCallback((text: string) => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    if (text.trim().length === 0) return
    socket.send(JSON.stringify({ type: 'chat', text }))
  }, [])

  return { ...state, join, attach, leave, dismissSignIn, confirmPickup, sendChat }
}

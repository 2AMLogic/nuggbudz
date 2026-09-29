import { parseSauceSelection, type SauceSelection } from '@shared/sauces'

/**
 * The seat a signed-out buyer was taking when they were asked to sign in (#150).
 *
 * Sign-in is a full-page round trip through Google, so everything in React state
 * is gone by the time the callback lands back on `/`. Losing the deal and the
 * sauces to that trip would make the interstitial cost more than the gate it
 * replaced, so they are written down first, here, and read back once on return.
 *
 * Deliberately **not** the coordinates. A precise fix is opt-in per visit and
 * is not worth persisting to storage for the length of a redirect; the returning
 * socket is placed by its connection, like any buyer who never tapped the
 * precise-location control.
 */
export interface PendingSeat {
  dealId: string
  sauces: SauceSelection | null
  /** When the buyer asked, so a stale intent never takes a seat days later. */
  at: number
}

/**
 * `sessionStorage`, not `localStorage`: the intent belongs to the tab that went
 * to sign in, and a second tab opened meanwhile must not inherit a seat it never
 * asked for.
 */
const PENDING_SEAT_KEY = 'nuggbudz.pendingSeat'

/**
 * How long a sign-in round trip may take and still count as the same attempt.
 * Long enough for a slow consent screen; short enough that a tab reopened
 * tomorrow does not queue anybody on the strength of a tap it cannot remember.
 */
export const PENDING_SEAT_TTL_MS = 15 * 60 * 1_000

/**
 * Read a stored intent defensively. Storage is shared with anything else on this
 * origin, so this is parsed like a value off a socket: the deal id is only
 * shape-checked (the server decides whether it is on offer, as it does for any
 * `join`), and the sauces go through the catalogue.
 */
export function parsePendingSeat(raw: unknown, now: number): PendingSeat | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { dealId, sauces, at } = raw as Record<string, unknown>
  if (typeof dealId !== 'string' || dealId.length === 0 || dealId.length > 64) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (at > now || now - at > PENDING_SEAT_TTL_MS) return null
  return { dealId, sauces: sauces === null ? null : parseSauceSelection(sauces), at }
}

/** Remember the seat being taken, just before the sign-in redirect. */
export function stashPendingSeat(seat: Omit<PendingSeat, 'at'>, now = Date.now()): void {
  try {
    sessionStorage.setItem(PENDING_SEAT_KEY, JSON.stringify({ ...seat, at: now }))
  } catch {
    // A private window: the buyer signs in and picks again, which is the old cost.
  }
}

/** Read and forget the stashed seat, so it can only ever be resumed once. */
export function takePendingSeat(now = Date.now()): PendingSeat | null {
  try {
    const raw = sessionStorage.getItem(PENDING_SEAT_KEY)
    sessionStorage.removeItem(PENDING_SEAT_KEY)
    return raw === null ? null : parsePendingSeat(JSON.parse(raw), now)
  } catch {
    return null
  }
}

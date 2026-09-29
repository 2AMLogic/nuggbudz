/**
 * What an identity on a settled split is allowed to be.
 *
 * Exactly two paths mint an identity for a pool socket: a real sign-in, which
 * hands the socket the `users.id` that `worker/auth.ts` minted with
 * `crypto.randomUUID()`, and demo pairing, which mints `demo:<uuid>`.
 * Everything downstream receives that id as a plain string — over the upgrade
 * query string into the Durable Object, out of a hibernation attachment, into
 * the ledger write — so by the time it matters there is no type left carrying
 * the fact that either path produced it.
 *
 * This module is the value-level answer to that, and it lives in `shared/` so
 * it is testable without a Workers runtime. The ledger needs the third answer
 * most: an id that names nobody must not be booked as revenue merely because it
 * does not begin with `demo:`.
 */
import { DEMO_USER_ID_PREFIX, isDemoUserId } from './demo'
import { HONEYPOT_USER_ID_PREFIX, isHoneypotUserId } from './honeypot'

/**
 * Canonical UUID — the shape of every account id this system mints, because
 * `users.id` is a `crypto.randomUUID()` and nothing else ever writes it.
 *
 * Hex case is accepted either way, and the version nibble is deliberately not
 * pinned: `crypto.randomUUID()` yields a lowercase v4 today, and a pattern
 * tight enough to encode that would turn a future change of id generator into
 * silently unbooked revenue rather than a failed test.
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Which path could have minted an id — or none of them.
 *
 * `honeypot` is the third minting path and the only one the *server* invents for
 * itself: no socket, no session, nobody on the other end. It is its own answer
 * rather than folded into `demo` because the two are excluded for different
 * reasons — a demo pair is a real handshake that is not revenue, and a honeypot
 * is not a person — and because collapsing them would mean a honeypot inherited
 * `demo`'s answers everywhere by accident rather than by decision.
 */
export type UserIdKind = 'account' | 'demo' | 'honeypot' | 'unauthentic'

/** True when this id is shaped like the account id a real sign-in mints. */
export function isAccountIdShaped(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_PATTERN.test(raw)
}

/**
 * Which path minted this id, or `unauthentic` when neither could have.
 *
 * Takes `unknown` rather than `string` on purpose: the callers that matter are
 * checking a value that arrived as JSON or as a query parameter, where a missing
 * field is exactly the case worth catching.
 *
 * A demo id is held to a looser standard than an account id, deliberately.
 * Answering `account` is what lets money be booked, so that answer is given
 * only to the one shape a sign-in can produce; answering `demo` books nothing
 * at all, so demanding more than the prefix and something after it would
 * protect nothing.
 */
export function classifyUserId(raw: unknown): UserIdKind {
  if (typeof raw !== 'string') return 'unauthentic'
  if (isDemoUserId(raw)) {
    return raw.length > DEMO_USER_ID_PREFIX.length ? 'demo' : 'unauthentic'
  }
  // Held to the same loose standard as a demo id, for the same reason: this
  // answer books nothing and can never be charged, so demanding more than the
  // prefix and something after it would protect nothing.
  if (isHoneypotUserId(raw)) {
    return raw.length > HONEYPOT_USER_ID_PREFIX.length ? 'honeypot' : 'unauthentic'
  }
  return isAccountIdShaped(raw) ? 'account' : 'unauthentic'
}

/**
 * May this identity take a seat in the pool — the one place that is answered.
 *
 * Since #150 the socket is open to everyone: a signed-out visitor is welcomed,
 * placed, and shown the market like any other socket, because the count of
 * people waiting nearby is the product's whole argument and asking for an
 * account before showing it asked people to sign up to find out whether signing
 * up was worth it. What an account buys is the *seat*, and this is the gate.
 *
 * Two identity kinds and one permission:
 *
 * - An **account** (a real sign-in) may always take a seat.
 * - An **anonymous** browser — the `demo:` identity off the per-browser cookie,
 *   or a throwaway minted at upgrade — may take one only when
 *   `ALLOW_DEMO_PAIRING` says so. That is the *only* question the flag answers
 *   now. It used to be answered at the socket as well, where it meant something
 *   else ("you may connect"), and the two readings came apart the moment the
 *   socket opened to everyone.
 * - Anything else names nobody and is refused, the fail-closed direction.
 *
 * Everything downstream follows from *who took the seat*, never from a second
 * reading of the flag: `paymentDisposition` answers `demo` off the two user ids
 * before Stripe is consulted, so a pair with an anonymous buyer in it is never
 * charged — which is exactly why this gate has to be on the server, in the
 * `join` path, and nowhere a client could skip it. An anonymous seat on a
 * charged deployment would be a free pair, not a UX wrinkle.
 */
export function seatVerdict(
  userId: unknown,
  anonymousSeatsAllowed: boolean,
): 'seat' | 'sign_in_required' {
  switch (classifyUserId(userId)) {
    case 'account':
      return 'seat'
    case 'demo':
      return anonymousSeatsAllowed ? 'seat' : 'sign_in_required'
    default:
      return 'sign_in_required'
  }
}

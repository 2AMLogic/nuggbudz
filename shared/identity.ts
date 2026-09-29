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

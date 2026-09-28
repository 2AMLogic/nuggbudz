/**
 * Who is allowed to resolve a dispute.
 *
 * Authentication already exists and is not this: `shared/auth.ts` decides
 * whether a cookie names a real Google account. This decides whether that
 * account is one of ours, which is a different question with a different failure
 * mode — an under-authenticated admin write path passes every test that only
 * asks "did the right thing happen for the right caller".
 *
 * An allowlist of account ids rather than a shared bearer token, because a
 * resolution moves money and the row it writes records *who* decided. A token
 * can only ever record "whoever had the token". Runtime-free, so the parsing
 * rules below are testable without a Worker.
 */
import { classifyUserId } from './identity'

/**
 * Read the operator allowlist out of a Worker var.
 *
 * Comma- or whitespace-separated `users.id` values. Two rules, both fail-closed:
 *
 * 1. An entry that is not shaped like an id a sign-in could have minted is
 *    dropped, not honoured. `demo:` ids are minted freely by
 *    `ALLOW_DEMO_PAIRING` and a wildcard is not an id at all, so neither may
 *    ever become an operator by being typed into a var.
 * 2. An unset, empty or entirely unusable var yields no operators — which means
 *    the admin surface answers as though it does not exist. A deployment that
 *    forgot to configure one has no operators rather than open ones.
 */
export function parseOperatorIds(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  const ids = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => classifyUserId(entry) === 'account')
  // Deduplicated so a var listing one operator twice does not read as two.
  return [...new Set(ids)]
}

/**
 * Is this signed-in account an operator?
 *
 * Takes the id off a session, never off a request body — the whole value of
 * this over a bearer token is that the identity was established elsewhere.
 */
export function isOperator(userId: string, allowlist: readonly string[]): boolean {
  // An empty allowlist can never match, which is the case worth stating: it is
  // reached by an unconfigured deployment, not by a misspelled id.
  if (allowlist.length === 0) return false
  return allowlist.includes(userId)
}

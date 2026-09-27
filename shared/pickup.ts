/**
 * The pickup handshake: the short code that proves two buddies actually met,
 * and the rules for when a half-finished handoff becomes a dispute.
 *
 * Deliberately runtime-free. The DO owns the match record, but "did both sides
 * confirm, and has the other side run out of time" is the part worth arguing
 * about, so it has to be testable without a Workers runtime.
 */
import type { BuyerRole } from './economics'

/**
 * Code alphabet, minus every character a stranger reads wrong off a receipt:
 * no 0/O, no 1/I/L. 31^6 is ~887 million codes, and a code is only guessable
 * for the minutes a single match is live.
 */
export const PICKUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export const PICKUP_CODE_LENGTH = 6

/** How long a one-sided confirmation waits for its other half. */
export const DEFAULT_PICKUP_TIMEOUT_MS = 5 * 60 * 1000

/** Epoch millis each side confirmed the handoff; null until they do. */
export interface PickupConfirmations {
  orderer: number | null
  receiver: number | null
}

export function noConfirmations(): PickupConfirmations {
  return { orderer: null, receiver: null }
}

/**
 * A fresh pickup code.
 *
 * Never derived from the match id: a match id travels in every `matched`
 * message, so deriving the code from it would hand the receiver the proof of
 * meeting before they had gone anywhere.
 */
export function generatePickupCode(): string {
  // Rejection sampling rather than a bare modulo: 256 is not a multiple of 31,
  // so `byte % 31` alone would make the first few letters measurably likelier.
  const ceiling = Math.floor(256 / PICKUP_CODE_ALPHABET.length) * PICKUP_CODE_ALPHABET.length
  const bytes = new Uint8Array(PICKUP_CODE_LENGTH * 2)
  let code = ''
  while (code.length < PICKUP_CODE_LENGTH) {
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= ceiling) continue
      code += PICKUP_CODE_ALPHABET[byte % PICKUP_CODE_ALPHABET.length]
      if (code.length === PICKUP_CODE_LENGTH) break
    }
  }
  return code
}

/**
 * Fold a code as typed into the form it is compared in.
 *
 * Spaces, dashes and case are what a person adds reading six characters aloud,
 * so they are stripped rather than treated as a wrong code. Look-alikes are not
 * remapped: the alphabet already excludes every character they collide with, so
 * an `O` is a typo with no valid reading.
 */
export function normalizePickupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function isPickupCode(value: string): boolean {
  if (value.length !== PICKUP_CODE_LENGTH) return false
  return Array.from(value).every((char) => PICKUP_CODE_ALPHABET.includes(char))
}

export function bothConfirmed(confirmations: PickupConfirmations): boolean {
  return confirmations.orderer !== null && confirmations.receiver !== null
}

/** The one side that has confirmed, while the handshake is still half done. */
export function confirmedRole(confirmations: PickupConfirmations): BuyerRole | null {
  if (bothConfirmed(confirmations)) return null
  if (confirmations.orderer !== null) return 'orderer'
  if (confirmations.receiver !== null) return 'receiver'
  return null
}

/** The side still owing a confirmation, while the handshake is half done. */
export function pendingRole(confirmations: PickupConfirmations): BuyerRole | null {
  const confirmed = confirmedRole(confirmations)
  if (confirmed === null) return null
  return confirmed === 'orderer' ? 'receiver' : 'orderer'
}

/**
 * When a half-confirmed handoff turns into a dispute, or null if there is
 * nothing to wait for — nobody has confirmed, or both sides have.
 */
export function disputeDeadline(
  confirmations: PickupConfirmations,
  timeoutMs: number,
): number | null {
  const confirmed = confirmedRole(confirmations)
  if (confirmed === null) return null
  const at = confirmations[confirmed]
  return at === null ? null : at + timeoutMs
}

/**
 * Has a one-sided confirmation run out of patience?
 *
 * The point of the timeout is that silence is not agreement: one buddy claiming
 * the handoff happened settles nothing on its own.
 */
export function isPickupDisputed(
  confirmations: PickupConfirmations,
  now: number,
  timeoutMs: number,
): boolean {
  const deadline = disputeDeadline(confirmations, timeoutMs)
  return deadline !== null && now >= deadline
}

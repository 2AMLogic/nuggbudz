import { parseSauceSelection, SAUCES_PER_SELECTION, type SauceSelection } from '@shared/sauces'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Mirrors `nuggbudz.demoName` in `src/App.tsx`. A demo buyer has no account by
 * design, so this browser is the only place their pair can live; a signed-in
 * buyer gets it written here too, which is what makes a reload instant instead of
 * waiting on a round trip.
 */
const SAUCE_KEY = 'nuggbudz.sauces'

/**
 * Read the remembered pair.
 *
 * Validated, not trusted: `localStorage` is shared with anything else running on
 * this origin and survives a menu change, so a stored value is parsed against the
 * catalogue exactly like a value off a socket.
 */
function readStored(): SauceSelection | null {
  try {
    const raw = localStorage.getItem(SAUCE_KEY)
    if (raw === null) return null
    return parseSauceSelection(JSON.parse(raw))
  } catch {
    // Private window, or something else wrote nonsense under our key.
    return null
  }
}

function writeStored(selection: SauceSelection): void {
  try {
    localStorage.setItem(SAUCE_KEY, JSON.stringify(selection))
  } catch {
    // A private window just means the pair is not remembered.
  }
}

export interface SauceChoice {
  /** Sauces tapped so far, in tap order: none, one, or the two that make a pair. */
  picks: readonly string[]
  /** The finished pair in catalogue order, or null while fewer than two are in. */
  selection: SauceSelection | null
  /** Tap a sauce. Tapping one twice is a double order; a third tap starts over. */
  tap: (sauceId: string) => void
}

/**
 * Hold the buyer's sauce pair, and put it somewhere it survives.
 *
 * Two homes, for two kinds of buyer. A signed-in buyer's pair goes to their
 * account, so it comes back after a sign-out and on another device; a demo buyer
 * has no account on purpose, so `localStorage` is theirs and it is the right
 * answer rather than a fallback. Both write locally, so a reload never waits on
 * the network to show what you picked.
 */
export function useSauces(signedIn: boolean): SauceChoice {
  const [picks, setPicks] = useState<readonly string[]>(() => readStored() ?? [])
  /** Set once the buyer taps, so an in-flight server answer cannot overrule them. */
  const touched = useRef(false)

  const persist = useCallback(
    (selection: SauceSelection) => {
      writeStored(selection)
      if (!signedIn) return
      void fetch('/api/me/sauces', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sauces: selection }),
      }).catch(() => {
        // Offline. The local copy stands, and the next pick tries again.
      })
    },
    [signedIn],
  )

  const tap = useCallback(
    (sauceId: string) => {
      touched.current = true
      // A full pair plus one tap is a fresh start, not a third sauce: two is the
      // whole selection, so the newest tap becomes the new first pick.
      const next = picks.length >= SAUCES_PER_SELECTION ? [sauceId] : [...picks, sauceId]
      setPicks(next)
      const complete = parseSauceSelection(next)
      if (complete !== null) persist(complete)
    },
    [picks, persist],
  )

  useEffect(() => {
    if (!signedIn) return
    let cancelled = false

    void (async () => {
      try {
        const response = await fetch('/api/me/sauces', { credentials: 'same-origin' })
        if (!response.ok) return
        const body = (await response.json()) as { sauces?: unknown }
        // Never over a choice made while this was in flight — and validated, since
        // a response is data like any other.
        if (cancelled || touched.current) return
        const stored = parseSauceSelection(body.sauces)
        if (stored !== null) {
          setPicks(stored)
          return
        }
        // The account has no pair yet, so adopt what this browser remembers:
        // signing in should not lose a pick made a moment before it.
        const local = readStored()
        if (local !== null) persist(local)
      } catch {
        // Offline, or the endpoint is unreachable. The local pair still stands.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [signedIn, persist])

  const selection = useMemo(() => parseSauceSelection(picks), [picks])

  return { picks, selection, tap }
}

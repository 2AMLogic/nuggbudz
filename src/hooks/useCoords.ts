import { useCallback, useState } from 'react'

export interface Fix {
  lat: number
  lng: number
}

/**
 * Precise location, and only when the buyer asks for it.
 *
 * Nothing here runs on its own. Pairing does not need it: the Worker resolves a
 * location for the socket from the edge, so tapping "Find a bud" never produces
 * a permission prompt. This hook exists for the one case that is worth a prompt
 * — two buyers about to walk to each other who want the distance between them to
 * be right — and it is wired to an explicit control, the way once-around keeps
 * `requestGeolocation()` behind a button rather than on load.
 *
 * A refusal is not an error state. It leaves the fix unset, which is the same
 * situation as never having asked, and pairing carries on from the edge.
 */
export function useCoords() {
  const [pending, setPending] = useState(false)
  const [fix, setFix] = useState<Fix | null>(null)
  /** Set when the device was asked and refused; pairing still works without it. */
  const [notice, setNotice] = useState<string | null>(null)

  const requestPrecise = useCallback((): Promise<Fix | null> => {
    if (!('geolocation' in navigator)) {
      setNotice('This browser has no location. Pairing still works without it.')
      return Promise.resolve(null)
    }

    setPending(true)
    setNotice(null)

    return new Promise<Fix | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const precise = { lat: position.coords.latitude, lng: position.coords.longitude }
          setPending(false)
          setFix(precise)
          resolve(precise)
        },
        () => {
          setPending(false)
          setNotice('Location is off. Pairing still works — you are placed by your connection.')
          resolve(null)
        },
        { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
      )
    })
  }, [])

  return { pending, notice, fix, requestPrecise }
}

import { useCallback, useState } from 'react'

/**
 * A demo location, used when the browser will not give up the real one.
 *
 * A hackathon venue is exactly where geolocation fails: denied permissions, no
 * GPS indoors, a laptop on conference wifi. Falling back to a fixed coordinate
 * keeps the pairing demo alive, and the UI says plainly that it is doing so
 * rather than pretending the fix is real.
 */
const DEMO_ORIGIN = { lat: 37.7955, lng: -122.3937 }

export interface Fix {
  lat: number
  lng: number
  /** True when this came from the device, false when it is the demo origin. */
  real: boolean
}

export function useCoords() {
  const [pending, setPending] = useState(false)
  /** Set when the device refused; the demo origin is used anyway. */
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * Resolve a coordinate, always. Location failure downgrades to the demo
   * origin rather than rejecting, so a denied prompt cannot dead-end the flow.
   */
  const locate = useCallback((): Promise<Fix> => {
    if (!('geolocation' in navigator)) {
      setNotice('This browser has no location. Using the demo cell.')
      return Promise.resolve({ ...DEMO_ORIGIN, real: false })
    }

    setPending(true)
    setNotice(null)

    return new Promise<Fix>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setPending(false)
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            real: true,
          })
        },
        () => {
          setPending(false)
          setNotice('Location is off. Using the demo cell so you can still pair.')
          resolve({ ...DEMO_ORIGIN, real: false })
        },
        { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
      )
    })
  }, [])

  return { pending, notice, locate }
}

import { type NearbyStores, parseNearbyStores } from '@shared/stores'
import { useEffect, useState } from 'react'

/**
 * The chain's stores around where the server placed you, once you are placed.
 *
 * Asks nothing of the browser and sends no position: the Worker centres the
 * search itself. Any failure — a 503 because Overpass is down or rate-limited, a
 * network error, a body that does not parse — leaves this null, which the map
 * reads as "nothing known about stores" and draws exactly as it did before there
 * were any. Nothing about pairing waits on it.
 */
export function useStores(dealId: string | null, placed: boolean): NearbyStores | null {
  const [nearby, setNearby] = useState<NearbyStores | null>(null)

  useEffect(() => {
    setNearby(null)
    if (dealId === null || !placed) return
    const controller = new AbortController()
    fetch(`/api/stores?dealId=${encodeURIComponent(dealId)}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!controller.signal.aborted) setNearby(parseNearbyStores(body))
      })
      .catch(() => {
        // Aborted or unreachable: no stores on the map, and nothing else changes.
      })
    return () => controller.abort()
  }, [dealId, placed])

  return nearby
}

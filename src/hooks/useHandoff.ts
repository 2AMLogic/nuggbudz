import { pickupCodeFromPath } from '@shared/handoff'
import { useCallback, useState } from 'react'

/**
 * The pickup code this browser arrived carrying, if it came in on a handoff link.
 *
 * A phone's own camera app opens `/h/<code>` as an ordinary navigation, so the
 * code is in the path of the very first render. Three things happen to it here
 * and nothing else happens to it anywhere:
 *
 * 1. **It is read once, during the first render.** Not in an effect — an effect
 *    runs after a paint, and the whole point is that the screen already knows.
 * 2. **The address bar is rewritten to `/` immediately.** A pickup code is a
 *    single-use proof that two people met; leaving it in the URL bar, in the
 *    back stack and in whatever the browser syncs is a worse place for it than
 *    the screen it is printed on. A reload then lands on the app rather than
 *    replaying the link.
 * 3. **Nothing is sent anywhere.** This hook has no socket, no fetch and no
 *    storage. Opening the link cannot confirm, settle or book anything — it can
 *    only put six characters where the receiver would have typed them. A link
 *    that moved money when opened is a link a bystander can photograph across a
 *    table and tap from their seat.
 */
export function useHandoff(): { code: string | null; dismiss: () => void } {
  const [code, setCode] = useState<string | null>(() => {
    const found = pickupCodeFromPath(window.location.pathname)
    if (found === null) return null
    try {
      window.history.replaceState(null, '', '/')
    } catch {
      // A sandboxed frame with no session history. The code is still in hand;
      // only the tidy-up failed.
    }
    return found
  })
  // Called when the screen the code was for is finished with — the match ended,
  // or the buyer tapped away from the link. Without it, leaving a match would
  // drop straight back onto the handoff screen, since the path it came from is
  // long gone from the address bar.
  const dismiss = useCallback(() => setCode(null), [])
  return { code, dismiss }
}

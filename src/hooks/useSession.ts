import type { PublicUser } from '@shared/auth'
import { useCallback, useEffect, useState } from 'react'

export interface SessionState {
  user: PublicUser | null
  /** True until the first `/api/auth/me` answer lands. */
  pending: boolean
}

/**
 * Who the server says you are.
 *
 * The session itself is an HttpOnly cookie this code cannot read, so identity is
 * always a question for the Worker rather than something held in the client.
 */
export function useSession() {
  const [state, setState] = useState<SessionState>({ user: null, pending: true })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (!response.ok) {
        setState({ user: null, pending: false })
        return
      }
      const body = (await response.json()) as { user: PublicUser }
      setState({ user: body.user, pending: false })
    } catch {
      setState({ user: null, pending: false })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signIn = useCallback(() => {
    window.location.assign('/api/auth/google/start')
  }, [])

  const signOut = useCallback(async (): Promise<void> => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
    setState({ user: null, pending: false })
  }, [])

  return { ...state, signIn, signOut, refresh }
}

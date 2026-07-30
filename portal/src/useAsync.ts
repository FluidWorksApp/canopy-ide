// Every panel does the same three things: fire an RPC when what it depends on
// changes, show that it is working, and say what went wrong instead of showing
// an empty list. Doing that once here is what keeps each panel down to a query
// and a projection.

import { useCallback, useEffect, useState } from 'react'

/** When a load stops being "just a moment" and starts needing an explanation.
 *  A local IDE answers in milliseconds; the same read over a phone tunnel can
 *  take seconds, and silence for seconds reads as broken. */
export const SLOW_AFTER_MS = 1200

export interface Async<T> {
  data?: T
  error?: string
  /** A request is in flight. True on a refresh too — the difference between
   *  "working" and "nothing to show" is exactly what was missing. */
  loading: boolean
  /** First load, with nothing on screen yet: the case that gets a skeleton. */
  cold: boolean
  /** In flight for longer than SLOW_AFTER_MS, so the UI can say so. */
  slow: boolean
  reload: () => void
}

export function useAsync<T>(run: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  })
  const [slow, setSlow] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, error: undefined, loading: true }))
    setSlow(false)
    const slowTimer = setTimeout(() => live && setSlow(true), SLOW_AFTER_MS)
    run().then(
      (data) => live && setState({ data, loading: false }),
      (e: unknown) =>
        live && setState({ error: String((e as Error)?.message ?? e), loading: false }),
    )
    return () => {
      live = false
      clearTimeout(slowTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, slow: slow && state.loading, cold: state.loading && state.data === undefined, reload }
}

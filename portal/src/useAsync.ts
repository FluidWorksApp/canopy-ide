// Every panel does the same three things: fire an RPC when what it depends on
// changes, show that it is working, and say what went wrong instead of showing
// an empty list. Doing that once here is what keeps each panel down to a query
// and a projection.

import { useCallback, useEffect, useState } from 'react'

export interface Async<T> {
  data?: T
  error?: string
  /** True only on the first load. A refresh keeps the old rows on screen — a
   *  list that blanks itself every four seconds is unusable on a phone. */
  loading: boolean
  reload: () => void
}

export function useAsync<T>(run: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: s.data === undefined }))
    run().then(
      (data) => live && setState({ data, loading: false }),
      (e: unknown) => live && setState({ error: String((e as Error)?.message ?? e), loading: false }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}

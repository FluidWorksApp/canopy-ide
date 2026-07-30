// The loading contract, which is the whole answer to "why does tapping a row
// look like nothing happened?". Each flag drives a different piece of UI, and
// getting them confused is what produced a panel that blanked itself on every
// refresh or, worse, showed nothing at all while it worked.

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAsync, SLOW_AFTER_MS } from './useAsync'

describe('useAsync', () => {
  it('is cold on the first load and warm on every one after', async () => {
    let resolve!: (v: string[]) => void
    const run = vi.fn(() => new Promise<string[]>((r) => (resolve = r)))
    const { result } = renderHook(() => useAsync(run, []))

    // Cold: nothing on screen, so the panel shows a skeleton.
    expect(result.current.cold).toBe(true)
    expect(result.current.loading).toBe(true)

    await act(async () => resolve(['a']))
    expect(result.current.cold).toBe(false)
    expect(result.current.data).toEqual(['a'])

    // A refresh is loading but NOT cold — the rows stay up and a progress line
    // appears. Blanking a readable list every four seconds is unusable.
    act(() => result.current.reload())
    expect(result.current.loading).toBe(true)
    expect(result.current.cold).toBe(false)
    expect(result.current.data).toEqual(['a'])
  })

  it('turns slow on only while it is still waiting', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (v: string) => void
      const { result } = renderHook(() =>
        useAsync(() => new Promise<string>((r) => (resolve = r)), []),
      )
      expect(result.current.slow).toBe(false)
      act(() => void vi.advanceTimersByTime(SLOW_AFTER_MS + 10))
      expect(result.current.slow).toBe(true)
      await act(async () => resolve('done'))
      // Settled: the "still loading" note must go, not linger over real data.
      expect(result.current.slow).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failure instead of an empty list', async () => {
    const { result } = renderHook(() =>
      useAsync(() => Promise.reject(new Error('git_status timed out')), []),
    )
    await waitFor(() => expect(result.current.error).toBe('git_status timed out'))
    expect(result.current.loading).toBe(false)
    expect(result.current.cold).toBe(false)
  })

  it('clears a previous error when it retries', async () => {
    let fail = true
    const { result } = renderHook(() =>
      useAsync(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve('ok')), []),
    )
    await waitFor(() => expect(result.current.error).toBe('boom'))
    fail = false
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.data).toBe('ok'))
    // A stale error beside fresh data is how a panel ends up shouting about a
    // failure it has already recovered from.
    expect(result.current.error).toBeUndefined()
  })
})

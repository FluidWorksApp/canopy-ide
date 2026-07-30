// Request/response over the one WebSocket.
//
// The server already speaks a generic action message (`act` -> `act-ack`, see
// portal.rs) that runs any command in the Rust GRANTS table and echoes the
// result. That is the whole reason a new remote panel is a manifest plus a view
// and never a new frame on the wire: this file turns that message pair into a
// promise, and every panel in the portal is written against it.
//
// The ack carries the client's own id back, so several calls can be in flight
// at once — which they are, the moment a wide screen shows three panels.

import type { Wire } from './wire'

/** How long a call waits before giving up. Long enough for `gh pr list` over a
 *  cold network, short enough that a wedged panel says so instead of spinning
 *  forever. */
const TIMEOUT_MS = 25_000

export interface Rpc {
  call<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>
  /** Drop every pending call — used when the socket drops, so a reconnect does
   *  not resolve promises against a server that has forgotten them. */
  reset(reason: string): void
}

interface Waiter {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function makeRpc(wire: Wire): Rpc {
  const waiting = new Map<string, Waiter>()
  let seq = 0

  wire.on((m) => {
    if (m.t !== 'act-ack') return
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    clearTimeout(w.timer)
    if (m.ok) w.resolve(m.result)
    else w.reject(new Error(String(m.error ?? 'failed')))
  })

  const settleAll = (reason: string) => {
    for (const [, w] of waiting) {
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    waiting.clear()
  }

  return {
    call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
      // Monotonic per connection. The id is also the server's replay key, so a
      // fresh one per call is what makes two identical reads two reads — the
      // single-flight guard is for the actions that spawn things, and none of
      // those are issued from here.
      const id = `r${++seq}`
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`${action} timed out`))
        }, TIMEOUT_MS)
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        wire.send({ t: 'act', id, action, args })
      })
    },
    reset: settleAll,
  }
}

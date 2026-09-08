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
import { HOST_PROTOCOL } from './contract'

/** How long a call waits before giving up. Long enough for `gh pr list` over a
 *  cold network, short enough that a wedged panel says so instead of spinning
 *  forever. */
const TIMEOUT_MS = 25_000

export interface Rpc {
  call<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>
  /** Drop pending callers. The host may have completed an operation even when
   * its response was lost, so reconnection must not blindly retry mutations. */
  reset(reason: string): void
  dispose(): void
  /** Subscribe to "is anything in flight". The shell shows one activity light
   *  from this, so a tap that kicks off a background load is acknowledged even
   *  on a panel that already has rows on screen. */
  onBusy(cb: (busy: boolean) => void): () => void
}

interface Waiter {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function makeRpc(wire: Wire): Rpc {
  const waiting = new Map<string, Waiter>()
  const busyCbs = new Set<(busy: boolean) => void>()
  const clientId = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("")
  let seq = 0
  let disposed = false
  let lastBusy = false

  // Only on a transition — a callback per settled request would re-render the
  // whole shell once per row on a panel that fires a dozen reads.
  const pumpBusy = () => {
    const busy = waiting.size > 0
    if (busy === lastBusy) return
    lastBusy = busy
    busyCbs.forEach((cb) => cb(busy))
  }

  const offMessage = wire.on((m) => {
    if (m.t !== 'act-ack') return
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    clearTimeout(w.timer)
    pumpBusy()
    if (m.ok) w.resolve(m.result)
    else w.reject(new Error(String(m.error ?? 'failed')))
  })

  const settleAll = (reason: string) => {
    for (const [, w] of waiting) {
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    waiting.clear()
    pumpBusy()
  }

  const offConnection = wire.onConnection(up => {
    if (!up) settleAll("Connection lost; an in-flight operation may have completed. Refresh its state before retrying.")
  })

  return {
    call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
      if (disposed || !wire.connected) return Promise.reject(new Error("Host is disconnected"))
      // Unique across tabs and refreshed browser pages. Monotonic per connection. The id is also the server's replay key, so a
      // fresh one per call is what makes two identical reads two reads — the
      // single-flight guard is for the actions that spawn things, and none of
      // those are issued from here.
      const id = `${clientId}:${++seq}`
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          pumpBusy()
          reject(new Error(`${action} timed out; it may have completed on the host. Refresh its state before retrying.`))
        }, TIMEOUT_MS)
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        pumpBusy()
        if (!wire.send({ t: 'act', protocol: HOST_PROTOCOL, id, action, args })) {
          clearTimeout(timer)
          waiting.delete(id)
          pumpBusy()
          reject(new Error("Host is disconnected or its send queue is full"))
        }
      })
    },
    reset: settleAll,
    dispose() {
      disposed = true
      offMessage()
      offConnection()
      settleAll("Host connection closed")
      busyCbs.clear()
    },
    onBusy(cb) {
      busyCbs.add(cb)
      cb(lastBusy)
      return () => busyCbs.delete(cb)
    },
  }
}

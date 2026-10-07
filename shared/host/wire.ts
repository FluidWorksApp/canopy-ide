// The portal's link to the embedded server (src-tauri/src/portal.rs): a PIN
// exchange for a bearer token, then short-lived tickets for WebSocket upgrades.

export type Msg = Record<string, any>

const TOKEN_KEY = 'canopy-remote-token'

export function savedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

/** Exchange the PIN for a bearer token. Throws on a bad PIN. */
export async function auth(pin: string): Promise<string> {
  const r = await fetch('/remote/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  if (!r.ok) throw new Error('Incorrect PIN')
  const j = await r.json()
  localStorage.setItem(TOKEN_KEY, j.token)
  return j.token as string
}

/** How often an open socket is pinged. The host answers each with a pong. */
export const HEARTBEAT_MS = 5_000
/** Silence after which an open socket is treated as dead, once a ping has gone
 *  unanswered. A phone that slept or switched networks, or a tunnel that dropped
 *  the connection without a close, leaves the browser reporting OPEN for
 *  minutes while every send — every keystroke — goes nowhere. */
export const STALE_MS = 15_000
/** How long a ping may go unanswered before that counts against the socket. */
const PROBE_MS = 4_000

type StatusCb = (up: boolean) => void
type AuthFailCb = () => void

export class Wire {
  private ws?: WebSocket
  private handlers = new Set<(m: Msg) => void>()
  private statusHandlers = new Set<StatusCb>()
  private closed = false
  private attempt = 0
  private generation = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private probe?: ReturnType<typeof setTimeout>
  private lastInbound = 0
  private lastPing = 0
  private watching = false
  private readonly wake = () => this.resume()
  onStatus?: StatusCb
  onAuthFail?: AuthFailCb

  private token: string

  constructor(token: string) { this.token = token }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN && !this.closed }

  onConnection(cb: StatusCb): () => void {
    this.statusHandlers.add(cb)
    return () => { this.statusHandlers.delete(cb) }
  }

  private status(up: boolean) {
    this.onStatus?.(up)
    this.statusHandlers.forEach(cb => cb(up))
  }

  connect() {
    this.closed = false
    const generation = ++this.generation
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopHeartbeat()
    this.ws?.close()
    this.watch(true)
    void this.open(generation)
  }

  /** Coming back to the page (a phone unlocking, a tab refocused) or the
   *  network returning is exactly when the socket is most likely dead and the
   *  reconnect backoff longest. Check now instead of waiting either out. */
  private watch(on: boolean) {
    if (on === this.watching || typeof document === 'undefined') return
    this.watching = on
    const method = on ? 'addEventListener' : 'removeEventListener'
    document[method]('visibilitychange', this.wake)
    window[method]('online', this.wake)
  }

  private resume() {
    if (this.closed || document.visibilityState === 'hidden') return
    if (!this.connected) {
      this.attempt = 0
      this.connect()
      return
    }
    this.ping()
    clearTimeout(this.probe)
    this.probe = setTimeout(() => {
      this.probe = undefined
      if (this.connected && this.lastInbound < this.lastPing) this.drop()
    }, PROBE_MS)
  }

  private ping() {
    this.lastPing = Date.now()
    this.send({ t: 'ping' })
  }

  private tick() {
    if (!this.connected) return
    const now = Date.now()
    const unanswered = this.lastPing > this.lastInbound && now - this.lastPing >= PROBE_MS
    if (unanswered && now - this.lastInbound >= STALE_MS) this.drop()
    else this.ping()
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeat)
    clearTimeout(this.probe)
    this.heartbeat = undefined
    this.probe = undefined
  }

  /** Abandon a socket that stopped answering and open a fresh one. */
  private drop() {
    this.stopHeartbeat()
    const ws = this.ws
    this.generation += 1
    this.ws = undefined
    ws?.close()
    this.status(false)
    this.attempt = 0
    this.connect()
  }

  private async open(generation: number) {
    let ticket: string
    try {
      const response = await fetch('/remote/ws-ticket', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
      })
      if (response.status === 401) {
        if (generation !== this.generation || this.closed) return
        this.status(false)
        this.onAuthFail?.()
        return
      }
      if (!response.ok) throw new Error(`ticket request failed: ${response.status}`)
      ticket = String((await response.json()).ticket ?? '')
      if (!ticket) throw new Error('ticket response was empty')
    } catch {
      if (generation === this.generation && !this.closed) this.scheduleReconnect()
      return
    }
    if (generation !== this.generation || this.closed) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/remote/ws?ticket=${encodeURIComponent(ticket)}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      if (generation !== this.generation || this.closed) {
        ws.close()
        return
      }
      this.attempt = 0
      this.lastInbound = Date.now()
      this.lastPing = 0
      this.stopHeartbeat()
      this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS)
      this.status(true)
    }
    ws.onclose = () => {
      if (generation !== this.generation) return
      this.stopHeartbeat()
      this.status(false)
      if (!this.closed) this.scheduleReconnect()
    }
    ws.onmessage = (e) => {
      if (generation !== this.generation || this.closed || ws.readyState !== WebSocket.OPEN) return
      this.lastInbound = Date.now()
      try {
        const m = JSON.parse(e.data)
        if (m?.t === 'pong') return
        this.handlers.forEach((h) => h(m))
      } catch {
        /* ignore malformed frames */
      }
    }
  }

  private scheduleReconnect() {
    if (this.retryTimer || this.closed) return
    const base = Math.min(30_000, 750 * 2 ** Math.min(this.attempt++, 6))
    const delay = base * (0.8 + Math.random() * 0.4)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect()
    }, delay)
  }

  send(m: Msg): boolean {
    if (!this.connected || !this.ws) return false
    // Refuse rather than retaining an unbounded browser-side write queue.
    if (this.ws.bufferedAmount > 1024 * 1024) return false
    try {
      this.ws.send(JSON.stringify(m))
      return true
    } catch { return false }
  }

  on(h: (m: Msg) => void): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  close() {
    this.closed = true
    this.generation += 1
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopHeartbeat()
    this.watch(false)
    this.ws?.close()
    this.status(false)
  }
}

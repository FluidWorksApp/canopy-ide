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

type StatusCb = (up: boolean) => void
type AuthFailCb = () => void

export class Wire {
  private ws?: WebSocket
  private handlers = new Set<(m: Msg) => void>()
  private closed = false
  private attempt = 0
  private generation = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  onStatus?: StatusCb
  onAuthFail?: AuthFailCb

  constructor(private token: string) {}

  connect() {
    this.closed = false
    const generation = ++this.generation
    void this.open(generation)
  }

  private async open(generation: number) {
    let ticket: string
    try {
      const response = await fetch('/remote/ws-ticket', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
      })
      if (response.status === 401) {
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
      this.onStatus?.(true)
    }
    ws.onclose = () => {
      if (generation !== this.generation) return
      this.onStatus?.(false)
      if (!this.closed) this.scheduleReconnect()
    }
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data)
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

  send(m: Msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m))
    }
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
    this.ws?.close()
  }
}

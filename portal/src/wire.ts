// The portal's link to the embedded server (src-tauri/src/portal.rs): a PIN
// exchange for a bearer token, then a single WebSocket carrying the same JSON
// protocol Phase 2 will move onto WebTransport unchanged.

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
  private everOpened = false
  private closed = false
  onStatus?: StatusCb
  onAuthFail?: AuthFailCb

  constructor(private token: string) {}

  connect() {
    this.closed = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/remote/ws?token=${encodeURIComponent(this.token)}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      this.everOpened = true
      this.onStatus?.(true)
    }
    ws.onclose = () => {
      this.onStatus?.(false)
      if (this.closed) return
      // Never opened → the token was rejected at upgrade; send the user back
      // to the PIN screen instead of reconnecting forever.
      if (!this.everOpened) {
        this.onAuthFail?.()
        return
      }
      setTimeout(() => this.connect(), 1500)
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
    this.ws?.close()
  }
}

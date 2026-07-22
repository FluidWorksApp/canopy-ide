// The mobile shell's Transport: it pipes over the WebSocket to the desktop's
// real PTYs. Input typed here is written to the same process the desktop shows;
// output is the live mirror of that process. (The desktop shell implements the
// same interface over Tauri IPC.)

import type { Transport } from '@shared/transport'
import type { Wire, Msg } from './wire'

export function wsTransport(wire: Wire): Transport {
  return {
    attachPty(pty, h) {
      const off = wire.on((m: Msg) => {
        if (m.pty !== pty) return
        if (m.t === 'pty-reset') h.onReset()
        else if (m.t === 'pty-size') h.onSize(m.cols, m.rows)
        else if (m.t === 'pty') {
          const bin = atob(m.b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          h.onData(bytes)
        } else if (m.t === 'pty-gone') h.onGone()
      })
      wire.send({ t: 'attach', pty })
      return () => {
        off()
        wire.send({ t: 'detach', pty })
      }
    },
    writePty(pty, data) {
      wire.send({ t: 'input', pty, data })
    },
    killPty(pty) {
      wire.send({ t: 'kill', pty })
    },
  }
}

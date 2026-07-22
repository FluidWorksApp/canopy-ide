import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Transport } from './transport'

// A live view of one agent's PTY, over any Transport. Attaches on mount (the
// transport replies with the grid size, a scrollback snapshot, then the live
// tail), writes keystrokes typed into it straight back as input, detaches on
// unmount. You can also type via the shell's composer + control-key row — both
// paths write to the same PTY.
//
// Sizing is authoritative to the PTY, not the device: we render at the PTY's
// exact cols/rows and scale the font so those columns fit the viewport width, so
// a desktop-width TUI (e.g. Claude Code) renders faithfully instead of wrapping.
export function AgentTerminal({ transport, pty }: { transport: Transport; pty: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      convertEol: false,
      cursorBlink: true,
      theme: { background: 'rgba(0,0,0,0)', foreground: '#c9d1d9' },
      allowTransparency: true,
    })
    term.open(ref.current!)

    let grid = { cols: 80, rows: 24 }
    const rescale = () => {
      const box = ref.current
      if (!box) return
      const avail = box.clientWidth - 8
      if (avail <= 0) return
      const px = Math.max(5, Math.min(14, Math.floor(avail / grid.cols / 0.6)))
      if (term.options.fontSize !== px) term.options.fontSize = px
      try {
        term.resize(grid.cols, grid.rows)
      } catch {
        /* transient */
      }
    }

    const detach = transport.attachPty(pty, {
      onReset: () => term.reset(),
      onSize: (cols, rows) => {
        grid = { cols: cols || 80, rows: rows || 24 }
        rescale()
      },
      onData: (bytes) => term.write(bytes),
      onGone: () => term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n'),
    })
    const onData = term.onData((d) => transport.writePty(pty, d))

    const ro = new ResizeObserver(() => rescale())
    if (ref.current) ro.observe(ref.current)

    return () => {
      detach()
      onData.dispose()
      ro.disconnect()
      term.dispose()
    }
  }, [transport, pty])

  return <div className="term" ref={ref} />
}

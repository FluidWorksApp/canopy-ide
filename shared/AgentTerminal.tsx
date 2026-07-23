import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Transport } from './transport'

// A live view of one agent's PTY, over any Transport. Attaches on mount (the
// transport replies with the grid size, a scrollback snapshot, then the live
// tail), writes keystrokes typed into it straight back as input, detaches on
// unmount. You can also type via the shell's composer + control-key row — both
// paths write to the same PTY.
//
// Sizing fits the DEVICE, not the PTY: we hold a fixed, legible font and size
// the grid to as many columns as the viewport holds, so long lines soft-wrap
// down the screen instead of running off the right edge. We deliberately do NOT
// resize the PTY to match — it is shared with the desktop shell, and shrinking
// it to phone width would reflow that window too. So xterm renders narrower than
// the PTY's grid; the incoming rows simply wrap at the viewport edge.
export function AgentTerminal({ transport, pty }: { transport: Transport; pty: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      convertEol: false,
      cursorBlink: true,
      theme: { background: 'rgba(0,0,0,0)', foreground: '#c9d1d9' },
      allowTransparency: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)

    // Fit the grid to the container at the current font, so text wraps to the
    // phone's width. Runs on attach, on every container resize, and whenever the
    // PTY reports a new upstream size (its rows keep arriving; only our wrap
    // width is local).
    const refit = () => {
      if (!ref.current || ref.current.clientWidth <= 0) return
      try {
        fit.fit()
      } catch {
        /* transient during layout */
      }
    }
    refit()

    const detach = transport.attachPty(pty, {
      onReset: () => term.reset(),
      onSize: () => refit(),
      onData: (bytes) => term.write(bytes),
      onGone: () => term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n'),
    })
    const onData = term.onData((d) => transport.writePty(pty, d))

    const ro = new ResizeObserver(() => refit())
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

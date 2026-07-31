import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Transport } from './transport'

// A live view of one agent's PTY, over any Transport. Attaches on mount (the
// transport replies with the grid size, a scrollback snapshot, then the live
// tail), writes keystrokes typed into it straight back as input, detaches on
// unmount. Typing into it IS the input path wherever there is a real keyboard;
// the shell's composer and control-key row are the substitute for one on touch
// devices, and both paths write to the same PTY.
//
// Sizing is authoritative to the PTY, not the device: we render at the PTY's
// exact cols/rows and scale the font so those columns fit the viewport width, so
// a desktop-width TUI (e.g. Claude Code) renders faithfully instead of wrapping.
// A full-screen TUI paints with absolute cursor positioning tied to the PTY's
// width, so a narrower local grid does NOT soft-wrap — it shreds the layout.
// The PTY is shared with the desktop shell and must not be resized to the phone.
export function AgentTerminal({
  transport,
  pty,
  autoFocus,
}: {
  transport: Transport
  pty: number
  /** Take the keyboard on open. Only ever true where there is a hardware one:
   *  focusing xterm on a touch device summons the on-screen keyboard over the
   *  view the user just asked to look at, and the shell's composer is the input
   *  there anyway. */
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Read at open, never a dependency: a changed value must not tear the
  // terminal down and reattach the PTY behind it.
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus
  // Reported, not inferred. `.term:has(.xterm.focus)` does work — xterm sets
  // that class and the selector repaints — but it reads a class off xterm's
  // private DOM, which is not API: rename it upstream and the ring silently
  // stops appearing, with no type error and no failing test. `textarea` is in
  // xterm's published typings, so this leans on the supported handle instead.
  const [focused, setFocused] = useState(false)

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
    if (autoFocusRef.current) term.focus()

    // xterm routes all key input through an off-screen helper textarea, so its
    // focus is the terminal's focus. There is no onFocus/onBlur in the public
    // API — `textarea` is the documented handle.
    const ta = term.textarea
    const onFocusIn = () => setFocused(true)
    const onFocusOut = () => setFocused(false)
    ta?.addEventListener('focus', onFocusIn)
    ta?.addEventListener('blur', onFocusOut)
    setFocused(document.activeElement === ta)

    let grid = { cols: 80, rows: 24 }
    const rescale = () => {
      const box = ref.current
      if (!box) return
      const avail = box.clientWidth - 8
      if (avail <= 0) return
      // Scale the font so the PTY's columns fit the viewport width — but never
      // below a legible floor. A wide desktop grid used to shrink to an
      // unreadable 5px to fit; now it holds a readable size and the terminal
      // scrolls horizontally instead (see .term overflow-x in styles.css).
      const px = Math.max(9, Math.min(16, Math.floor(avail / grid.cols / 0.6)))
      if (term.options.fontSize !== px) term.options.fontSize = px
      try {
        term.resize(grid.cols, grid.rows)
      } catch {
        /* transient */
      }
      // The grid keeps the size the desktop gave it, so on a phone it can be
      // taller than the pane holding it — and taller still once the keyboard
      // steals half the screen. Keep the box scrolled to the newest rows: the
      // prompt is what you need in view while typing, not the first screenful.
      requestAnimationFrame(() => {
        if (box.isConnected) box.scrollTop = box.scrollHeight
      })
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
      ta?.removeEventListener('focus', onFocusIn)
      ta?.removeEventListener('blur', onFocusOut)
      setFocused(false)
      detach()
      onData.dispose()
      ro.disconnect()
      term.dispose()
    }
  }, [transport, pty])

  return <div className={focused ? 'term term-focused' : 'term'} ref={ref} />
}

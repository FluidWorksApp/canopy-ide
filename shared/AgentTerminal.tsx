import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { createTerminal, preferredTerminalEngine } from './terminalEngine'
import { defaultFitMode, terminalFontPx, type FitMode } from './terminalFit'
import type { Transport } from './transport'

// A live view of one agent's PTY, over any Transport. Attaches on mount (the
// transport replies with the grid size, a scrollback snapshot, then the live
// tail), writes keystrokes typed into it straight back as input, detaches on
// unmount. Typing into it IS the input path wherever there is a real keyboard;
// the shell's composer and control-key row are the substitute for one on touch
// devices, and both paths write to the same PTY.
//
// We render at the PTY's exact cols/rows: a TUI paints with absolute cursor
// moves tied to that grid, so a narrower local grid shreds the layout, and the
// PTY is the desktop's and is never resized from here. "Fit width" shrinks the
// text so every column shows; "Readable" keeps it legible and pans sideways.
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
  // Why typing is not reaching the PTY right now (reconnecting, refused), or
  // null. Input is queued or refused by the transport, never silently lost, and
  // this is where the person typing finds out.
  const [notice, setNotice] = useState<string | null>(null)
  // The person's choice on this device, or null for the default per grid.
  const [chosen, setChosen] = useState<FitMode | null>(readFitChoice)
  const chosenRef = useRef(chosen)
  chosenRef.current = chosen
  const [mode, setMode] = useState<FitMode>('readable')
  const [moreRight, setMoreRight] = useState(false)
  const rescaleRef = useRef<() => void>(() => {})

  useEffect(() => {
    // Our Ghostty engine, as in the desktop tabs; xterm when it cannot run
    // in this browser or was turned off (see preferredTerminalEngine).
    const { term } = createTerminal({
      engine: preferredTerminalEngine(),
      scrollback: 1000,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      theme: { background: 'rgba(0,0,0,0)', foreground: '#c9d1d9' },
      allowTransparency: true,
      xtermAddons: 'none',
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
      const next = chosenRef.current ?? defaultFitMode(avail, grid.cols)
      setMode(next)
      const px = terminalFontPx(avail, grid.cols, next)
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
        if (!box.isConnected) return
        // A grid shorter than the pane sits at the bottom, by the keys.
        const gridH = Math.max(0, ...[...box.querySelectorAll('.xterm-screen, .xterm-screen > canvas')].map((e) => e.getBoundingClientRect().height))
        box.style.paddingTop = `${Math.max(PAD, box.clientHeight - PAD - gridH)}px`
        box.scrollTop = box.scrollHeight
        if (next === 'fit') box.scrollLeft = 0
        updateMore()
      })
    }
    const updateMore = () => {
      const box = ref.current
      if (box) setMoreRight(box.scrollLeft + box.clientWidth < box.scrollWidth - 4)
    }
    rescaleRef.current = rescale
    ref.current?.addEventListener('scroll', updateMore, { passive: true })

    const detach = transport.attachPty(pty, {
      onReset: () => term.reset(),
      onSize: (cols, rows) => {
        grid = { cols: cols || 80, rows: rows || 24 }
        rescale()
      },
      onData: (bytes) => term.write(bytes),
      onGone: () => term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n'),
      onNotice: setNotice,
    })
    const onData = term.onData((d) => transport.writePty(pty, d))

    const ro = new ResizeObserver(() => rescale())
    const box0 = ref.current
    if (box0) ro.observe(box0)

    return () => {
      ta?.removeEventListener('focus', onFocusIn)
      ta?.removeEventListener('blur', onFocusOut)
      setFocused(false)
      setNotice(null)
      detach()
      onData.dispose()
      ro.disconnect()
      box0?.removeEventListener('scroll', updateMore)
      rescaleRef.current = () => {}
      term.dispose()
    }
  }, [transport, pty])

  useEffect(() => rescaleRef.current(), [chosen])

  const toggle = () => {
    const next: FitMode = mode === 'fit' ? 'readable' : 'fit'
    writeFitChoice(next)
    setChosen(next)
  }

  return (
    <div className="term-host">
      {notice && (
        <div className="term-notice" role="status">
          {notice}
        </div>
      )}
      <div className="term-frame">
        <div className={focused ? 'term term-focused' : 'term'} ref={ref} />
        <button
          type="button"
          className="term-fit"
          onClick={toggle}
          aria-pressed={mode === 'fit'}
          title={mode === 'fit' ? 'Show text at a readable size' : 'Fit every column on screen'}
        >
          {mode === 'fit' ? 'Readable' : 'Fit width'}
        </button>
        {moreRight && mode === 'readable' && (
          <div className="term-more" aria-hidden="true">
            more →
          </div>
        )}
      </div>
    </div>
  )
}

/** .term's padding in styles.css. */
const PAD = 10
const FIT_KEY = 'canopy-remote-term-fit'

function readFitChoice(): FitMode | null {
  try {
    const v = localStorage.getItem(FIT_KEY)
    return v === 'fit' || v === 'readable' ? v : null
  } catch {
    return null
  }
}

function writeFitChoice(mode: FitMode) {
  try {
    localStorage.setItem(FIT_KEY, mode)
  } catch {
    /* private window: the choice lasts this visit */
  }
}

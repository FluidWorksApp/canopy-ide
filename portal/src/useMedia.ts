// One breakpoint, one decision.
//
// The portal ships two shells, not one layout with responsive tweaks: below the
// line it is a phone IDE (one pane at a time, a bottom tab bar, sheets), above
// it a real three-pane one (rail, list, detail, all live at once). Those are
// different component trees because they are different products — trying to CSS
// one into the other is what produced "a wide phone" the last time.
//
// 900px is where a list pane (300px) and a detail pane wide enough for an
// 80-column diff both fit without either becoming a slit. A portrait iPad
// (768px) is deliberately BELOW it: portrait wants the phone shell, landscape
// (1024px) wants the desk one, and that matches how people hold the thing.

import { useEffect, useState } from 'react'

export const WIDE_QUERY = '(min-width: 900px)'

/**
 * Does this device have a keyboard the user can drive a TUI with?
 *
 * Width alone is the wrong question. The terminal already forwards every
 * keystroke to the PTY, so where there is a real keyboard the composer and the
 * control-key row are dead weight sitting between the user and the shell — but
 * on a keyboardless screen they are the *only* way to type, and hiding them
 * strands the session. A landscape tablet is wide and has neither, which is
 * exactly the case a width breakpoint gets wrong.
 *
 * `hover: hover` plus `pointer: fine` is the honest proxy: a trackpad or mouse
 * travels with a keyboard, and a bare touchscreen reports neither. An iPad
 * reports both only once its keyboard case is attached, which is precisely when
 * it should behave like a desk.
 */
export const KEYBOARD_QUERY = '(min-width: 900px) and (hover: hover) and (pointer: fine)'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (e: MediaQueryListEvent) => setMatches(e.matches)
    mq.addEventListener('change', on)
    setMatches(mq.matches)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

export function useWide(): boolean {
  return useMediaQuery(WIDE_QUERY)
}

/** See KEYBOARD_QUERY. Gates the on-screen input aids, nothing else — the two
 *  shells are still chosen by `useWide`, because that is a layout question. */
export function useHardwareKeyboard(): boolean {
  return useMediaQuery(KEYBOARD_QUERY)
}

/** Publish the *visible* viewport as CSS vars. `100dvh` still counts the strip
 *  behind the on-screen keyboard on Android Chrome and iOS Safari, so a shell
 *  sized to it puts its composer under the keys. `--vh` is what the user can
 *  actually see; `--vv-top` is how far the browser has pushed the visual
 *  viewport down, which iOS does instead of resizing. */
export function useViewportFit() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty('--vh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.style.removeProperty('--vh')
      root.style.removeProperty('--vv-top')
    }
  }, [])
}

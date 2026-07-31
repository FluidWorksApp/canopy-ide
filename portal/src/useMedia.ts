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

export function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(WIDE_QUERY).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY)
    const on = (e: MediaQueryListEvent) => setWide(e.matches)
    mq.addEventListener('change', on)
    setWide(mq.matches)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
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

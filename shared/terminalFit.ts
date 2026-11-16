// Font size for a remote view of a PTY whose grid belongs to the desktop.
// "fit" shrinks the text until every column fits; "readable" keeps a legible
// size and lets the grid pan sideways.

export type FitMode = 'fit' | 'readable'

/** Monospace cell width as a share of the font size. */
const CELL = 0.6
export const READABLE_MIN_PX = 9
export const FIT_MIN_PX = 4
export const MAX_PX = 16
/** Below this, fitting every column is too small to be the default. */
export const FIT_DEFAULT_MIN_PX = 7

const fitPx = (width: number, cols: number) => Math.floor((width / cols / CELL) * 2) / 2

export function terminalFontPx(width: number, cols: number, mode: FitMode): number {
  const px = fitPx(width, Math.max(1, cols))
  const min = mode === 'fit' ? FIT_MIN_PX : READABLE_MIN_PX
  return Math.max(min, Math.min(MAX_PX, mode === 'fit' ? px : Math.floor(px)))
}

/** Fit when every column still reads at a usable size, otherwise readable. */
export function defaultFitMode(width: number, cols: number): FitMode {
  return fitPx(width, Math.max(1, cols)) >= FIT_DEFAULT_MIN_PX ? 'fit' : 'readable'
}

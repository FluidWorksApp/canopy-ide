import { describe, expect, it } from 'vitest'
import { defaultFitMode, terminalFontPx } from './terminalFit'

describe('remote terminal font size', () => {
  it('fit shrinks a desktop-wide grid until every column fits', () => {
    const px = terminalFontPx(382, 146, 'fit')
    expect(px).toBe(4)
    expect(146 * px * 0.6).toBeLessThanOrEqual(382)
  })

  it('readable keeps 9px or more and leaves the grid wider than the phone', () => {
    expect(terminalFontPx(382, 146, 'readable')).toBe(9)
    expect(terminalFontPx(382, 40, 'readable')).toBe(15)
  })

  it('never goes past 16px on a narrow grid', () => {
    expect(terminalFontPx(1200, 40, 'fit')).toBe(16)
  })

  it('defaults to fit only where every column still reads', () => {
    expect(defaultFitMode(382, 146)).toBe('readable')
    expect(defaultFitMode(860, 120)).toBe('fit')
  })
})

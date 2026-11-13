// Colours: the skin's 16 + the fixed xterm 256 table, and the packed colour
// words the engine hands back (see canopy-term-wasm: 0 default, 0x01000000|n
// palette, 0x02000000|rgb).

export interface TermColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const FALLBACK_ANSI = [
  0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
  0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` to 0xRRGGBB; null when the
 *  string is something else (a named colour, a CSS variable). */
export function parseCssColor(value: string | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return (r << 16) | (g << 8) | b;
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (m) return parseInt(m[1], 16);
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (m) {
    return ((Number(m[1]) & 255) << 16) | ((Number(m[2]) & 255) << 8) | (Number(m[3]) & 255);
  }
  return null;
}

export function cssOf(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

export interface Palette {
  /** 256 entries, 0xRRGGBB. */
  table: Uint32Array;
  fg: number;
  bg: number;
  cursor: number;
  selection: number;
  /** selectionBackground carried an alpha below 1: blend it over the cell. */
  selectionAlpha: number;
}

export function buildPalette(theme: Partial<TermColors> | undefined): Palette {
  const table = new Uint32Array(256);
  for (let i = 0; i < 16; i++) {
    table[i] = parseCssColor(theme?.[ANSI_KEYS[i]]) ?? FALLBACK_ANSI[i];
  }
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    const r = steps[Math.floor(i / 36)];
    const g = steps[Math.floor(i / 6) % 6];
    const b = steps[i % 6];
    table[16 + i] = (r << 16) | (g << 8) | b;
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    table[232 + i] = (v << 16) | (v << 8) | v;
  }
  const fg = parseCssColor(theme?.foreground) ?? 0xd4d4d4;
  const bg = parseCssColor(theme?.background) ?? 0x1e1e1e;
  const selectionText = theme?.selectionBackground?.trim() ?? "";
  let selectionAlpha = 1;
  const hexAlpha = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(selectionText);
  const fnAlpha = /^rgba\([^)]*?([\d.]+)\s*\)$/i.exec(selectionText);
  if (hexAlpha) selectionAlpha = parseInt(hexAlpha[1], 16) / 255;
  else if (fnAlpha) selectionAlpha = Math.min(1, Number(fnAlpha[1]));
  return {
    table,
    fg,
    bg,
    cursor: parseCssColor(theme?.cursor) ?? fg,
    selection: parseCssColor(selectionText) ?? 0x264f78,
    selectionAlpha,
  };
}

export const COLOR_DEFAULT = 0;
const KIND_INDEXED = 0x01000000;
const KIND_RGB = 0x02000000;

/** A packed colour word to 0xRRGGBB, or -1 for "default". */
export function resolveColor(packed: number, palette: Palette): number {
  if (packed === COLOR_DEFAULT) return -1;
  if ((packed & 0xff000000) === KIND_INDEXED) return palette.table[packed & 0xff];
  if ((packed & 0xff000000) === KIND_RGB) return packed & 0xffffff;
  return -1;
}

export function isIndexed(packed: number): boolean {
  return (packed & 0xff000000) === KIND_INDEXED;
}

export function blend(over: number, under: number, alpha: number): number {
  const mix = (shift: number) =>
    Math.round(((over >> shift) & 255) * alpha + ((under >> shift) & 255) * (1 - alpha));
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

function luminance(rgb: number): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((rgb >> 16) & 255) +
    0.7152 * channel((rgb >> 8) & 255) +
    0.0722 * channel(rgb & 255)
  );
}

export function contrastRatio(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` moved toward white or black until it reaches `ratio` against `bg`
 *  (xterm's minimumContrastRatio). Returns `fg` unchanged when it already
 *  does, or when `ratio` is 1. */
export function ensureContrast(fg: number, bg: number, ratio: number): number {
  if (ratio <= 1 || contrastRatio(fg, bg) >= ratio) return fg;
  const target = luminance(bg) < 0.5 ? 0xffffff : 0x000000;
  let best = fg;
  for (let step = 1; step <= 10; step++) {
    best = blend(target, fg, step / 10);
    if (contrastRatio(best, bg) >= ratio) break;
  }
  return best;
}

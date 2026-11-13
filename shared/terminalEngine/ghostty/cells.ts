// Reading the engine's packed cells (see canopy-term-wasm): six u32 per cell.
//   0 first scalar (0: blank, or the right half of a wide character)
//   1 foreground   2 background   (packed colours, see palette.ts)
//   3 attrs (bits 0-15) | underline style << 16
//   4 cluster index (0: word 0 is the whole text)
//   5 underline colour

export const WORDS = 6;

export const ATTR_BOLD = 1;
export const ATTR_ITALIC = 1 << 1;
export const ATTR_UNDERLINE = 1 << 2;
export const ATTR_INVERSE = 1 << 3;
export const ATTR_STRIKE = 1 << 4;
export const ATTR_DIM = 1 << 5;
export const ATTR_HIDDEN = 1 << 6;
export const ATTR_WIDE_TAIL = 1 << 7;

/** One line of cells: `cols * WORDS` words and the cluster texts they index. */
export interface Line {
  cells: Uint32Array;
  clusters: readonly string[];
}

export const EMPTY_LINE: Line = { cells: new Uint32Array(0), clusters: [] };

export function lineCols(line: Line): number {
  return line.cells.length / WORDS;
}

export function cellText(line: Line, col: number): string {
  const i = col * WORDS;
  const cells = line.cells;
  if (cells[i + 3] & ATTR_WIDE_TAIL) return "";
  const cluster = cells[i + 4];
  if (cluster) return line.clusters[cluster] ?? "";
  const ch = cells[i];
  return ch === 0 ? " " : String.fromCodePoint(ch);
}

function blankCell(line: Line, col: number): boolean {
  const i = col * WORDS;
  const ch = line.cells[i];
  return (ch === 0 || ch === 32) && (line.cells[i + 3] & ATTR_WIDE_TAIL) === 0;
}

/** The engine does not hand out soft-wrap flags for every row, so a row whose
 *  last cell is written counts as continuing on the next one. Replaying such a
 *  row without a newline draws the same screen either way: the next character
 *  wraps by itself. */
export function lineWraps(line: Line): boolean {
  const cols = lineCols(line);
  return cols > 0 && !blankCell(line, cols - 1);
}

/** Text of columns `[from, to)`. Wide characters appear once. */
export function lineText(line: Line, trimRight: boolean, from = 0, to = lineCols(line)): string {
  const end = Math.min(to, lineCols(line));
  let out = "";
  for (let col = Math.max(0, from); col < end; col++) out += cellText(line, col);
  return trimRight ? out.replace(/[ \u0000]+$/, "") : out;
}

/** For each UTF-16 index of `lineText(line, false)`, the column it sits in,
 *  plus one trailing entry (the column after the last character). */
export function textColumns(line: Line): number[] {
  const map: number[] = [];
  const cols = lineCols(line);
  for (let col = 0; col < cols; col++) {
    const text = cellText(line, col);
    for (let k = 0; k < text.length; k++) map.push(col);
  }
  map.push(cols);
  return map;
}

function sgrColor(packed: number, base: 30 | 40): string {
  const kind = packed & 0xff000000;
  if (kind === 0x01000000) {
    const n = packed & 0xff;
    if (n < 8) return String(base + n);
    if (n < 16) return String(base + 60 + n - 8);
    return `${base + 8};5;${n}`;
  }
  if (kind === 0x02000000) {
    return `${base + 8};2;${(packed >> 16) & 255};${(packed >> 8) & 255};${packed & 255}`;
  }
  return "";
}

function sgrFor(fg: number, bg: number, attrs: number, underlineColor: number): string {
  const parts = ["0"];
  const flags = attrs & 0xffff;
  const underline = (attrs >> 16) & 7;
  if (flags & ATTR_BOLD) parts.push("1");
  if (flags & ATTR_DIM) parts.push("2");
  if (flags & ATTR_ITALIC) parts.push("3");
  if (flags & ATTR_UNDERLINE) parts.push(underline > 1 ? `4:${underline}` : "4");
  if (flags & ATTR_INVERSE) parts.push("7");
  if (flags & ATTR_HIDDEN) parts.push("8");
  if (flags & ATTR_STRIKE) parts.push("9");
  const f = sgrColor(fg, 30);
  if (f) parts.push(f);
  const b = sgrColor(bg, 40);
  if (b) parts.push(b);
  const kind = underlineColor & 0xff000000;
  if (kind === 0x01000000) parts.push(`58:5:${underlineColor & 0xff}`);
  else if (kind === 0x02000000) {
    parts.push(
      `58:2::${(underlineColor >> 16) & 255}:${(underlineColor >> 8) & 255}:${underlineColor & 255}`,
    );
  }
  return `\x1b[${parts.join(";")}m`;
}

/** The row as text with the SGR sequences that reproduce its colours and
 *  styles, ending with the pen reset. Trailing default blanks are dropped. */
export function lineVt(line: Line): string {
  const cols = lineCols(line);
  const cells = line.cells;
  let end = cols;
  while (end > 0) {
    const i = (end - 1) * WORDS;
    const plain =
      (cells[i] === 0 || cells[i] === 32) &&
      cells[i + 2] === 0 &&
      (cells[i + 3] & (ATTR_WIDE_TAIL | ATTR_INVERSE | ATTR_UNDERLINE | ATTR_STRIKE)) === 0;
    if (!plain) break;
    end--;
  }
  let out = "";
  let fg = 0;
  let bg = 0;
  let attrs = 0;
  let uc = 0;
  let styled = false;
  for (let col = 0; col < end; col++) {
    const i = col * WORDS;
    const a = cells[i + 3] & ~ATTR_WIDE_TAIL;
    if (cells[i + 3] & ATTR_WIDE_TAIL) continue;
    if (cells[i + 1] !== fg || cells[i + 2] !== bg || a !== attrs || cells[i + 5] !== uc) {
      fg = cells[i + 1];
      bg = cells[i + 2];
      attrs = a;
      uc = cells[i + 5];
      out += sgrFor(fg, bg, attrs, uc);
      styled = fg !== 0 || bg !== 0 || attrs !== 0 || uc !== 0;
    }
    out += cellText(line, col);
  }
  return styled ? `${out}\x1b[0m` : out;
}

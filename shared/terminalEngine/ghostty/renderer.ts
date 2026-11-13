// Draws the engine's cells on a 2D canvas. The engine decides what is on
// screen; this only paints it, one row at a time, and only the rows that
// changed.
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_HIDDEN,
  ATTR_INVERSE,
  ATTR_ITALIC,
  ATTR_STRIKE,
  ATTR_UNDERLINE,
  ATTR_WIDE_TAIL,
  WORDS,
  type Line,
} from "./cells";
import { blend, cssOf, ensureContrast, isIndexed, resolveColor, type Palette } from "./palette";

export type CursorStyle = "block" | "underline" | "bar";

export interface CursorView {
  row: number;
  col: number;
  style: CursorStyle;
  /** Solid when the terminal has focus, an outline when it does not. */
  focused: boolean;
}

export interface RenderSource {
  cols: number;
  rows: number;
  /** Cells of viewport row `row`. */
  line(row: number): Line;
  /** Selected columns `[from, to)` of a viewport row, or null. */
  selection(row: number): readonly [number, number] | null;
  /** Columns `[from, to)` of the link under the pointer on this row, or null. */
  link(row: number): readonly [number, number] | null;
  /** null: no cursor drawn this frame (hidden, blinked off, scrolled away). */
  cursor: CursorView | null;
}

export interface Metrics {
  /** Cell size in CSS pixels. */
  cellWidth: number;
  cellHeight: number;
  /** Cell size in device pixels (whole numbers: no seams between cells). */
  deviceCellWidth: number;
  deviceCellHeight: number;
  dpr: number;
  /** False until a real measurement was taken in a laid-out element. */
  measured: boolean;
}

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  metrics: Metrics;
  private ctx: CanvasRenderingContext2D | null = null;
  private fontSize: number;
  private fontFamily: string;
  private baseline = 0;
  private fonts: string[] = [];
  private currentFont = "";
  private currentFill = "";

  /** The default background is left clear, for a terminal drawn over the
   *  page (xterm's allowTransparency). */
  private readonly transparent: boolean;

  constructor(ownerDocument: Document, fontSize: number, fontFamily: string, transparent = false) {
    this.transparent = transparent;
    this.canvas = ownerDocument.createElement("canvas");
    this.canvas.style.display = "block";
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.metrics = fallbackMetrics(fontSize, 1);
    this.buildFonts();
    try {
      this.ctx = this.canvas.getContext("2d", { alpha: transparent }) ?? null;
    } catch {
      // No canvas (a test DOM): everything but painting still works.
      this.ctx = null;
    }
  }

  get canPaint(): boolean {
    return this.ctx !== null;
  }

  setFont(fontSize: number, fontFamily: string): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.buildFonts();
  }

  /** Measure the font inside `host`. Returns false (and keeps the previous
   *  metrics) when `host` is not laid out, as in a hidden tab. */
  measure(host: HTMLElement): boolean {
    const view = host.ownerDocument.defaultView;
    const dpr = Math.max(1, view?.devicePixelRatio || 1);
    const probe = host.ownerDocument.createElement("span");
    probe.textContent = "W".repeat(32);
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;left:0;top:0;padding:0;margin:0;border:0;line-height:normal;";
    probe.style.fontFamily = this.fontFamily;
    probe.style.fontSize = `${this.fontSize}px`;
    host.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      if (!this.metrics.measured) this.metrics = fallbackMetrics(this.fontSize, dpr);
      return false;
    }
    const deviceCellWidth = Math.max(1, Math.round((rect.width / 32) * dpr));
    const deviceCellHeight = Math.max(1, Math.ceil(rect.height * dpr));
    this.metrics = {
      cellWidth: deviceCellWidth / dpr,
      cellHeight: deviceCellHeight / dpr,
      deviceCellWidth,
      deviceCellHeight,
      dpr,
      measured: true,
    };
    this.buildFonts();
    this.measureBaseline();
    return true;
  }

  /** Size the canvas for a grid. Clears it: paint every row afterwards. */
  resize(cols: number, rows: number): void {
    const m = this.metrics;
    const width = cols * m.deviceCellWidth;
    const height = rows * m.deviceCellHeight;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${width / m.dpr}px`;
    this.canvas.style.height = `${height / m.dpr}px`;
    this.currentFont = "";
    this.currentFill = "";
  }

  /** Paint rows. `dirty` null paints all of them. Returns how many it drew. */
  paint(
    source: RenderSource,
    dirty: Uint8Array | null,
    palette: Palette,
    minimumContrast: number,
  ): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    let drawn = 0;
    for (let row = 0; row < source.rows; row++) {
      if (dirty && !dirty[row]) continue;
      this.paintRow(ctx, source, row, palette, minimumContrast);
      drawn++;
    }
    return drawn;
  }

  private buildFonts(): void {
    const px = Math.max(1, Math.round(this.fontSize * this.metrics.dpr * 100) / 100);
    const family = this.fontFamily || "monospace";
    this.fonts = [
      `${px}px ${family}`,
      `bold ${px}px ${family}`,
      `italic ${px}px ${family}`,
      `italic bold ${px}px ${family}`,
    ];
    this.currentFont = "";
  }

  private measureBaseline(): void {
    const ctx = this.ctx;
    const m = this.metrics;
    let ascent = this.fontSize * m.dpr * 0.8;
    let descent = this.fontSize * m.dpr * 0.2;
    if (ctx) {
      ctx.font = this.fonts[0];
      this.currentFont = this.fonts[0];
      const tm = ctx.measureText("Mg");
      if (tm.fontBoundingBoxAscent > 0) {
        ascent = tm.fontBoundingBoxAscent;
        descent = tm.fontBoundingBoxDescent;
      }
    }
    this.baseline = Math.round((m.deviceCellHeight - (ascent + descent)) / 2 + ascent);
  }

  private fill(ctx: CanvasRenderingContext2D, rgb: number): void {
    const css = cssOf(rgb);
    if (css !== this.currentFill) {
      ctx.fillStyle = css;
      this.currentFill = css;
    }
  }

  private paintRow(
    ctx: CanvasRenderingContext2D,
    source: RenderSource,
    row: number,
    palette: Palette,
    minimumContrast: number,
  ): void {
    const m = this.metrics;
    const cw = m.deviceCellWidth;
    const ch = m.deviceCellHeight;
    const y = row * ch;
    const cols = source.cols;
    const line = source.line(row);
    const cells = line.cells;
    const have = Math.min(cols, cells.length / WORDS);
    const selection = source.selection(row);
    const link = source.link(row);
    const cursor = source.cursor && source.cursor.row === row ? source.cursor : null;

    if (this.transparent) {
      ctx.clearRect(0, y, cols * cw, ch);
    } else {
      this.fill(ctx, palette.bg);
      ctx.fillRect(0, y, cols * cw, ch);
    }

    // Backgrounds first, in runs, so a glyph that overhangs its cell is not
    // cut off by its neighbour's background.
    let runStart = 0;
    let runColor = -1;
    const flush = (end: number) => {
      if (runColor >= 0 && end > runStart) {
        this.fill(ctx, runColor);
        ctx.fillRect(runStart * cw, y, (end - runStart) * cw, ch);
      }
    };
    for (let col = 0; col < have; col++) {
      const bg = this.cellBackground(cells, col, palette, selection);
      const color = bg === palette.bg ? -1 : bg;
      if (color !== runColor) {
        flush(col);
        runStart = col;
        runColor = color;
      }
    }
    flush(have);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, cols * cw, ch);
    ctx.clip();
    ctx.textBaseline = "alphabetic";
    for (let col = 0; col < have; col++) {
      const i = col * WORDS;
      const attrs = cells[i + 3];
      if (attrs & ATTR_WIDE_TAIL) continue;
      const wide = col + 1 < have && (cells[i + WORDS + 3] & ATTR_WIDE_TAIL) !== 0;
      const underCursor = cursor !== null && cursor.col === col && cursor.focused && cursor.style === "block";
      const bg = underCursor ? palette.cursor : this.cellBackground(cells, col, palette, selection);
      let fg = underCursor ? palette.bg : this.cellForeground(cells, col, palette);
      if (!underCursor) fg = ensureContrast(fg, bg, minimumContrast);
      if (attrs & ATTR_DIM) fg = blend(fg, bg, 0.5);
      const x = col * cw;
      const width = (wide ? 2 : 1) * cw;
      if (underCursor) {
        this.fill(ctx, palette.cursor);
        ctx.fillRect(x, y, width, ch);
      }
      const code = cells[i];
      const cluster = cells[i + 4];
      if (!(attrs & ATTR_HIDDEN) && (cluster !== 0 || (code !== 0 && code !== 32))) {
        const font = this.fonts[(attrs & ATTR_BOLD ? 1 : 0) + (attrs & ATTR_ITALIC ? 2 : 0)];
        if (font !== this.currentFont) {
          ctx.font = font;
          this.currentFont = font;
        }
        this.fill(ctx, fg);
        const text = cluster ? (line.clusters[cluster] ?? "") : String.fromCodePoint(code);
        ctx.fillText(text, x, y + this.baseline);
      }
      const underline = attrs & ATTR_UNDERLINE ? (attrs >> 16) & 7 || 1 : 0;
      const linked = link !== null && col >= link[0] && col < link[1];
      if (underline || linked || attrs & ATTR_STRIKE) {
        const thickness = Math.max(1, Math.round(m.dpr));
        if (underline || linked) {
          const packed = cells[i + 5];
          const explicit = resolveColor(packed, palette);
          this.fill(ctx, explicit >= 0 && !linked ? explicit : fg);
          this.drawUnderline(ctx, linked && !underline ? 1 : underline, x, y, width, thickness);
        }
        if (attrs & ATTR_STRIKE) {
          this.fill(ctx, fg);
          ctx.fillRect(x, y + Math.round(ch * 0.5), width, thickness);
        }
      }
    }
    ctx.restore();
    // save()/restore() put back the context's own fill and font.
    this.currentFill = "";
    this.currentFont = "";

    if (cursor && !(cursor.focused && cursor.style === "block")) {
      const x = cursor.col * cw;
      const thickness = Math.max(1, Math.round(m.dpr));
      this.fill(ctx, palette.cursor);
      if (!cursor.focused) {
        ctx.fillRect(x, y, cw, thickness);
        ctx.fillRect(x, y + ch - thickness, cw, thickness);
        ctx.fillRect(x, y, thickness, ch);
        ctx.fillRect(x + cw - thickness, y, thickness, ch);
      } else if (cursor.style === "bar") {
        ctx.fillRect(x, y, Math.max(1, Math.round(m.dpr * 1.5)), ch);
      } else {
        ctx.fillRect(x, y + ch - thickness * 2, cw, thickness * 2);
      }
    }
  }

  private drawUnderline(
    ctx: CanvasRenderingContext2D,
    style: number,
    x: number,
    y: number,
    width: number,
    thickness: number,
  ): void {
    const ch = this.metrics.deviceCellHeight;
    const bottom = y + Math.min(ch - thickness, this.baseline + thickness * 2);
    switch (style) {
      case 2:
        ctx.fillRect(x, bottom - thickness * 2, width, thickness);
        ctx.fillRect(x, bottom, width, thickness);
        break;
      case 3: {
        // Curly: a shallow zigzag, two steps per cell.
        const step = Math.max(2, Math.round(width / 4));
        for (let dx = 0, up = true; dx < width; dx += step, up = !up) {
          ctx.fillRect(x + dx, up ? bottom - thickness : bottom, Math.min(step, width - dx), thickness);
        }
        break;
      }
      case 4:
        for (let dx = 0; dx < width; dx += thickness * 2) {
          ctx.fillRect(x + dx, bottom, thickness, thickness);
        }
        break;
      case 5: {
        const dash = Math.max(2, Math.round(width / 3));
        for (let dx = 0; dx < width; dx += dash * 2) {
          ctx.fillRect(x + dx, bottom, Math.min(dash, width - dx), thickness);
        }
        break;
      }
      default:
        ctx.fillRect(x, bottom, width, thickness);
    }
  }

  private cellBackground(
    cells: Uint32Array,
    col: number,
    palette: Palette,
    selection: readonly [number, number] | null,
  ): number {
    const i = col * WORDS;
    const attrs = cells[i + 3];
    let bg: number;
    if (attrs & ATTR_INVERSE) {
      const fg = resolveColor(cells[i + 1], palette);
      bg = fg >= 0 ? fg : palette.fg;
    } else {
      const own = resolveColor(cells[i + 2], palette);
      bg = own >= 0 ? own : palette.bg;
    }
    if (selection && col >= selection[0] && col < selection[1]) {
      return palette.selectionAlpha < 1
        ? blend(palette.selection, bg, palette.selectionAlpha)
        : palette.selection;
    }
    return bg;
  }

  private cellForeground(cells: Uint32Array, col: number, palette: Palette): number {
    const i = col * WORDS;
    const attrs = cells[i + 3];
    if (attrs & ATTR_INVERSE) {
      const bg = resolveColor(cells[i + 2], palette);
      return bg >= 0 ? bg : palette.bg;
    }
    const packed = cells[i + 1];
    // Bold text in one of the eight base colours is drawn in its bright
    // variant, as xterm does by default.
    if (attrs & ATTR_BOLD && isIndexed(packed) && (packed & 0xff) < 8) {
      return palette.table[(packed & 0xff) + 8];
    }
    const fg = resolveColor(packed, palette);
    return fg >= 0 ? fg : palette.fg;
  }
}

function fallbackMetrics(fontSize: number, dpr: number): Metrics {
  const deviceCellWidth = Math.max(1, Math.round(fontSize * 0.6 * dpr));
  const deviceCellHeight = Math.max(1, Math.ceil(fontSize * 1.2 * dpr));
  return {
    cellWidth: deviceCellWidth / dpr,
    cellHeight: deviceCellHeight / dpr,
    deviceCellWidth,
    deviceCellHeight,
    dpr,
    measured: false,
  };
}

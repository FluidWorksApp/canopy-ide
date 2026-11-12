import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STREAMS = ["mixed", "ascii", "sgr", "repaint", "wide"];
export const WRITE_SIZES = [4 * 1024, 64 * 1024];
export const COLS = 80;
export const ROWS = 24;
export const SCROLLBACK = 10_000;
export const MEM_LINES = 100_000;
// Outstanding bytes allowed before waiting for a write callback. Waiting on
// every 4 KiB write would add one timer tick per write and measure the timer.
export const WINDOW_BYTES = 256 * 1024;

export const loadStream = (dir, name) => new Uint8Array(readFileSync(join(dir, `${name}.bin`)));
export const saveJson = (path, obj) => writeFileSync(path, JSON.stringify(obj, null, 1) + "\n");
export const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
export const MIB = 1024 * 1024;

/** The line the memory tests feed: 76 columns, never wraps at 80. */
export const memLine = (i) =>
  `${String(i).padStart(6, "0")} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\r\n`;

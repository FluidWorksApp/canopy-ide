// Turning a PTY's raw bytes into text a human can read, without a terminal on
// screen. A micro-task runs detached now (no tab, no xterm), so the transcript
// its history entry keeps has to be reconstructed from the scrollback the Rust
// side holds — and that scrollback is raw: cursor moves, colour, alternate
// screen, the lot. Stripping escapes with a regex would leave an agent TUI's
// overdrawn frames stacked on top of each other, so the bytes are replayed
// through the same terminal emulator the visible tabs use and the buffer is read
// off the other side. Same parser, same result as Term's captureText.
import { Terminal } from "@xterm/xterm";

// Transcript capture is optional. Bound its parser and waiting inputs rather
// than let concurrent task completions grow xterm's write queue indefinitely.
// String accounting uses UTF-16 bytes, including both ASCII and surrogate pairs.
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_CAPTURES = 8;
const MAX_OUTPUT_CHARS = 64 * 1024;
interface Capture {
  raw: string;
  cols: number;
  rows: number;
  maxChars: number;
  resolve: (text: string) => void;
}
const queue: Capture[] = [];
let queuedBytes = 0;
let capturing = false;

function drainCaptures(): void {
  if (capturing) return;
  const capture = queue.shift();
  if (!capture) return;
  queuedBytes -= capture.raw.length * 2;
  capturing = true;
  let term: Terminal | undefined;
  let guard: number | undefined;
  let finished = false;
  const finish = (text: string) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(guard);
    // Disposing on success AND timeout releases the parser queue/cell graph.
    // A late callback from a timed-out parser cannot read the next capture.
    try { term?.dispose(); } finally {
      capturing = false;
      capture.resolve(text);
      queueMicrotask(drainCaptures);
    }
  };
  try {
    term = new Terminal({
      allowProposedApi: true,
      cols: capture.cols,
      rows: capture.rows,
      scrollback: 5000,
    });
    guard = window.setTimeout(() => finish(capture.raw.slice(-capture.maxChars)), 2000);
    term.write(capture.raw, () => {
      if (finished) return;
      try { finish(bufferTail(term!, capture.maxChars)); }
      catch { finish(capture.raw.slice(-capture.maxChars)); }
    });
  } catch {
    finish(capture.raw.slice(-capture.maxChars));
  }
}

/** Read the tail of a terminal buffer as plain text — the shared half of this
 *  and Term's captureText, kept identical on purpose: what a detached task
 *  stores in its history should be what the same run in a tab would have. */
export function bufferTail(term: Terminal, maxChars: number): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  let chars = 0;
  for (let i = buf.length - 1; i >= 0 && chars < maxChars; i--) {
    // `true` trims the padding xterm writes out to the full terminal width.
    const line = buf.getLine(i)?.translateToString(true) ?? "";
    lines.push(line);
    chars += line.length + 1;
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.reverse().join("\n").trimStart().slice(-maxChars);
}

/** Replay raw PTY output and return the tail of what it painted.
 *
 *  The grid has to match the one the PTY actually ran at (detached micro-tasks
 *  use 120x40) or every wrapped line lands in the wrong place. Resolves once
 *  xterm has finished parsing — `write` is asynchronous, and reading the buffer
 *  before its callback returns the frame as it was halfway through. */
export function renderPtyText(
  raw: string,
  opts: { cols?: number; rows?: number; maxChars?: number } = {},
): Promise<string> {
  const { cols = 120, rows = 40 } = opts;
  const requestedChars = opts.maxChars ?? 8000;
  const maxChars = Number.isFinite(requestedChars)
    ? Math.max(0, Math.min(MAX_OUTPUT_CHARS, Math.floor(requestedChars)))
    : 8000;
  if (!raw) return Promise.resolve("");
  if (maxChars === 0) return Promise.resolve("");
  const bytes = raw.length * 2;
  if (
    !Number.isInteger(cols) || cols < 1 || cols > 512 ||
    !Number.isInteger(rows) || rows < 1 || rows > 256 ||
    bytes > MAX_INPUT_BYTES || queue.length >= MAX_QUEUED_CAPTURES ||
    queuedBytes + bytes > MAX_QUEUED_BYTES
  ) {
    // Match the existing parser-timeout fallback; never replay a truncated ANSI
    // stream as though it were an accurate terminal screen.
    return Promise.resolve(raw.slice(-maxChars));
  }
  return new Promise((resolve) => {
    queue.push({ raw, cols, rows, maxChars, resolve });
    queuedBytes += bytes;
    drainCaptures();
  });
}

/** The last non-empty line the terminal painted — a one-line "what is it doing"
 *  for a run with no tab to glance at. */
export function lastPaintedLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

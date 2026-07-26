// Turning a PTY's raw bytes into text a human can read, without a terminal on
// screen. A micro-task runs detached now (no tab, no xterm), so the transcript
// its history entry keeps has to be reconstructed from the scrollback the Rust
// side holds — and that scrollback is raw: cursor moves, colour, alternate
// screen, the lot. Stripping escapes with a regex would leave an agent TUI's
// overdrawn frames stacked on top of each other, so the bytes are replayed
// through the same terminal emulator the visible tabs use and the buffer is read
// off the other side. Same parser, same result as Term's captureText.
import { Terminal } from "@xterm/xterm";

/** One offscreen terminal, reused. Constructing xterm is not cheap and a task
 *  finishing is not a rare event; `reset()` between runs is enough to keep two
 *  transcripts from bleeding into each other. Never `open()`ed — the buffer is
 *  the only part we want, and attaching it to the DOM would cost a renderer. */
let scratch: Terminal | null = null;

const scratchTerm = (cols: number, rows: number): Terminal => {
  if (!scratch) scratch = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 });
  else {
    scratch.reset();
    if (scratch.cols !== cols || scratch.rows !== rows) scratch.resize(cols, rows);
  }
  return scratch;
};

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
  const { cols = 120, rows = 40, maxChars = 8000 } = opts;
  if (!raw) return Promise.resolve("");
  return new Promise((resolve) => {
    let term: Terminal;
    try {
      term = scratchTerm(cols, rows);
    } catch {
      // No DOM, or xterm refused to construct (jsdom in tests). A transcript is
      // a nicety; losing it must never take the task's outcome down with it.
      resolve("");
      return;
    }
    // A wedged parser would leave the promise hanging and, with it, whatever is
    // awaiting the capture — settle on the raw text rather than never settling.
    const guard = window.setTimeout(() => resolve(raw.slice(-maxChars)), 2000);
    term.write(raw, () => {
      window.clearTimeout(guard);
      resolve(bufferTail(term, maxChars));
    });
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

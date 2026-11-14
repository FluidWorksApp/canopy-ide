// A repeatable terminal benchmark that runs inside the app, on the real
// webview, canvas and fonts, for both engines on the same bytes. It reports
// what a person feels: how long a big dump takes to land, how smooth the page
// stays while it does, and how long a small write takes to reach the screen.
// Timings only; the workload is generated, never the user's output.
import { createTerminal, ghosttyMemoryBytes, type TerminalEngine } from "./index";

export interface BenchResult {
  engine: TerminalEngine;
  /** The engine really used (Ghostty falls back to xterm when it cannot load). */
  ran: TerminalEngine;
  bytes: number;
  /** Wall time for the whole dump to be parsed, in chunks, as a PTY delivers it. */
  dumpMs: number;
  dumpMBps: number;
  /** Frame gaps while the dump ran (ms): the page staying responsive. */
  frameP50: number;
  frameP95: number;
  frameMax: number;
  /** A one-line write, to the next painted frame (ms), at idle. */
  echoP50: number;
  echoP95: number;
  /** Wasm memory after the run (Ghostty only; 0 otherwise). */
  engineMB: number;
}

export interface BenchOptions {
  /** Bytes of generated output (default 8 MiB). */
  bytes?: number;
  chunk?: number;
  echoes?: number;
  cols?: number;
  rows?: number;
}

/** Deterministic output: plain lines, SGR colours, wide characters, and a
 *  carriage-return progress line now and then, like real build and log output. */
export function workload(bytes: number): string[] {
  const chunks: string[] = [];
  let total = 0;
  let n = 0;
  while (total < bytes) {
    let line: string;
    switch (n % 8) {
      case 1:
        line = `\x1b[3${(n % 6) + 1}m[${String(n).padStart(7, "0")}]\x1b[0m info: request handled in ${(n * 7) % 997} ms path=/api/v1/items/${n % 4096}\r\n`;
        break;
      case 3:
        line = `\x1b[1;38;5;${(n % 200) + 16}mWARN\x1b[0m \x1b[2m${"=".repeat(60)}\x1b[0m ${n}\r\n`;
        break;
      case 5:
        line = `progress ${n % 100}%\r${"#".repeat(n % 50)}\x1b[K\r\n`;
        break;
      case 6:
        line = `日本語のテキスト ${n} ✔ café naïve résumé\r\n`;
        break;
      default:
        line = `${n} ${"lorem ipsum dolor sit amet ".repeat(3)}${n * 31}\r\n`;
    }
    chunks.push(line);
    total += line.length;
    n++;
  }
  return chunks;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

async function runOne(engine: TerminalEngine, opts: Required<BenchOptions>): Promise<BenchResult> {
  const host = document.createElement("div");
  // On the page and laid out (so it paints like a real tab), out of sight.
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:900px;height:600px;`;
  document.body.appendChild(host);
  const created = createTerminal({ engine, scrollback: 10000, cols: opts.cols, rows: opts.rows });
  try {
    const { term } = created;
    term.open(host);
    term.resize(opts.cols, opts.rows);
    await frame();

    const lines = workload(opts.bytes);
    // Frame gaps during the dump.
    const gaps: number[] = [];
    let running = true;
    const watcher = (async () => {
      let last = await frame();
      while (running) {
        const now = await frame();
        gaps.push(now - last);
        last = now;
      }
    })();

    // As a PTY delivers it: chunks, each fed after the last was parsed.
    let sent = 0;
    const started = performance.now();
    let batch = "";
    const flush = () =>
      new Promise<void>((resolve) => {
        const data = batch;
        batch = "";
        term.write(data, resolve);
      });
    for (const line of lines) {
      batch += line;
      sent += line.length;
      if (batch.length >= opts.chunk) await flush();
    }
    if (batch) await flush();
    const dumpMs = performance.now() - started;
    running = false;
    await watcher;

    // Idle round trips: write one line, wait for the next painted frame.
    const echoes: number[] = [];
    for (let i = 0; i < opts.echoes; i++) {
      await frame();
      await frame();
      const t0 = performance.now();
      await new Promise<void>((resolve) => term.write(`echo ${i}\r\n`, resolve));
      await frame();
      echoes.push(performance.now() - t0);
    }

    gaps.sort((a, b) => a - b);
    echoes.sort((a, b) => a - b);
    return {
      engine,
      ran: created.engine,
      bytes: sent,
      dumpMs,
      dumpMBps: sent / 1048576 / (dumpMs / 1000),
      frameP50: percentile(gaps, 50),
      frameP95: percentile(gaps, 95),
      frameMax: gaps.length ? gaps[gaps.length - 1] : 0,
      echoP50: percentile(echoes, 50),
      echoP95: percentile(echoes, 95),
      engineMB: engine === "ghostty" ? ghosttyMemoryBytes() / 1048576 : 0,
    };
  } finally {
    created.term.dispose();
    host.remove();
  }
}

/** Run the same workload on each engine, one after the other. */
export async function runTerminalBenchmark(
  options: BenchOptions = {},
  onProgress?: (engine: TerminalEngine) => void,
): Promise<BenchResult[]> {
  const opts: Required<BenchOptions> = {
    bytes: options.bytes ?? 8 * 1048576,
    chunk: options.chunk ?? 65536,
    echoes: options.echoes ?? 40,
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
  };
  const out: BenchResult[] = [];
  // Ghostty first, then xterm, then Ghostty again: the first run pays for
  // warm-up, so the second one is the fair comparison.
  for (const engine of ["ghostty", "xterm", "ghostty"] as const) {
    onProgress?.(engine);
    out.push(await runOne(engine, opts));
  }
  return out;
}

export function formatBenchmark(results: BenchResult[]): string[] {
  const ms = (n: number) => `${n.toFixed(1)}`;
  const rows = results.map((r, i) => {
    const name =
      r.engine === "ghostty"
        ? `${r.ran === "ghostty" ? "Ghostty" : "Ghostty→xterm"}${i === 2 ? " (warm)" : ""}`
        : "xterm";
    return `${name.padEnd(16)} ${r.dumpMBps.toFixed(1).padStart(6)} MB/s  frames p50 ${ms(r.frameP50)} p95 ${ms(r.frameP95)} max ${ms(r.frameMax)}  echo p50 ${ms(r.echoP50)} p95 ${ms(r.echoP95)} ms`;
  });
  return [
    `${(results[0].bytes / 1048576).toFixed(0)} MiB of generated output, 64 KiB chunks. Higher MB/s is better; lower ms is better.`,
    ...rows,
  ];
}

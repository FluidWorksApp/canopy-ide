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
  /** UTF-8 bytes of the dump. */
  bytes: number;
  /** Wall time from the first write to the last one being parsed (not painted). */
  dumpMs: number;
  dumpMBps: number;
  /** Frame gaps while the dump ran (ms): the page staying responsive. */
  frameP50: number;
  frameP95: number;
  frameMax: number;
  /** A one-line write, to the engine having parsed it (ms), at idle: the wait
   *  a keystroke's echo has before the engine can draw it. */
  echoP50: number;
  echoP95: number;
  /** Wasm memory after the run (Ghostty only; 0 otherwise). */
  engineMB: number;
}

export interface BenchOptions {
  /** Bytes of generated output per measured run (default 4 MiB). */
  bytes?: number;
  chunk?: number;
  echoes?: number;
  cols?: number;
  rows?: number;
  /** Measured runs per engine, after a discarded warm-up (default 3). */
  runs?: number;
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
  // On screen, laid out and painted like a real tab, but invisible: an
  // off-screen host could let an engine skip painting it.
  host.style.cssText = `position:fixed;left:0;top:0;width:900px;height:600px;opacity:0.001;pointer-events:none;z-index:2147483647;`;
  document.body.appendChild(host);
  const created = createTerminal({ engine, scrollback: 1000, cols: opts.cols, rows: opts.rows });
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

    // Chunks queued back to back, as a PTY reader does; the engine's own write
    // buffer paces them. Awaiting each chunk would time the engine's timer
    // instead of its parser.
    const encoder = new TextEncoder();
    let sent = 0;
    let batch = "";
    let last: Promise<void> = Promise.resolve();
    const started = performance.now();
    const flush = () => {
      const data = batch;
      sent += encoder.encode(data).length;
      batch = "";
      last = new Promise<void>((resolve) => term.write(data, resolve));
    };
    for (const line of lines) {
      batch += line;
      if (batch.length >= opts.chunk) flush();
    }
    if (batch) flush();
    await last;
    const dumpMs = performance.now() - started;
    running = false;
    await watcher;

    // Idle round trips: write one line, wait until the engine has parsed it.
    const echoes: number[] = [];
    for (let i = 0; i < opts.echoes; i++) {
      await frame();
      await frame();
      const t0 = performance.now();
      await new Promise<void>((resolve) => term.write(`echo ${i}\r\n`, resolve));
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

const median = (values: number[]) => percentile([...values].sort((x, y) => x - y), 50);

export interface BenchSummary {
  engine: TerminalEngine;
  ran: TerminalEngine;
  runs: number;
  dumpMBps: number;
  frameP95: number;
  frameMax: number;
  echoP50: number;
  echoP95: number;
  engineMB: number;
  bytes: number;
}

function summarise(engine: TerminalEngine, results: BenchResult[]): BenchSummary {
  const med = (pick: (r: BenchResult) => number) => median(results.map(pick));
  return {
    engine,
    ran: results[0].ran,
    runs: results.length,
    bytes: results[0].bytes,
    dumpMBps: med((r) => r.dumpMBps),
    frameP95: med((r) => r.frameP95),
    frameMax: med((r) => r.frameMax),
    echoP50: med((r) => r.echoP50),
    echoP95: med((r) => r.echoP95),
    engineMB: Math.max(...results.map((r) => r.engineMB)),
  };
}

/** The same workload on each engine. Each gets a short discarded warm-up
 *  (compiling, growing memory), then the measured runs alternate between the
 *  engines so drift in the machine's load hits both alike; the median is
 *  reported. */
export async function runTerminalBenchmark(
  options: BenchOptions = {},
  onProgress?: (engine: TerminalEngine) => void,
): Promise<BenchSummary[]> {
  const opts: Required<BenchOptions> = {
    bytes: options.bytes ?? 4 * 1048576,
    chunk: options.chunk ?? 65536,
    echoes: options.echoes ?? 30,
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    runs: options.runs ?? 3,
  };
  const engines = ["ghostty", "xterm"] as const;
  const warm = { ...opts, bytes: Math.min(opts.bytes, 1048576), echoes: 2 };
  for (const engine of engines) {
    onProgress?.(engine);
    await runOne(engine, warm);
  }
  const results: Record<TerminalEngine, BenchResult[]> = { ghostty: [], xterm: [] };
  for (let i = 0; i < opts.runs; i++) {
    for (const engine of engines) {
      onProgress?.(engine);
      results[engine].push(await runOne(engine, opts));
    }
  }
  return engines.map((engine) => summarise(engine, results[engine]));
}

export function formatBenchmark(summaries: BenchSummary[]): string[] {
  const ms = (n: number) => n.toFixed(1);
  const first = summaries[0];
  const lines = [
    `${(first.bytes / 1048576).toFixed(1)} MiB generated, median of ${first.runs} runs after a warm-up. Dump ends when parsed, not painted.`,
  ];
  for (const r of summaries) {
    const name = r.engine === "ghostty" ? (r.ran === "ghostty" ? "Ghostty" : "Ghostty→xterm") : "xterm";
    lines.push(`${name}: ${r.dumpMBps.toFixed(1)} MB/s dump`);
    lines.push(`  frame gap p95 ${ms(r.frameP95)} ms, worst ${ms(r.frameMax)} ms`);
    lines.push(`  echo to parsed p50 ${ms(r.echoP50)} ms, p95 ${ms(r.echoP95)} ms`);
  }
  return lines;
}

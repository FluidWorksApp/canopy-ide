// Combine the JSON the three engines wrote into markdown tables.
//   node report.mjs <results-dir> <label>   (markdown on stdout)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STREAMS, WRITE_SIZES } from "./common.mjs";

const [dir, label = process.platform] = process.argv.slice(2);
const load = (n) => (existsSync(join(dir, n)) ? JSON.parse(readFileSync(join(dir, n), "utf8")) : null);
const ours = load("ours.json");
const head = load("headless.json");
const chr = load("chromium.json");
const oursMem = load("ours-mem.json");
const headMem = load("headless-mem.json");
const chrMem = load("chromium-mem.json");

const find = (d, stream, write, mode) =>
  d?.rows?.find((r) => r.stream === stream && r.write === write && (!mode || r.mode === mode))?.mibs;
const f = (v) => (v == null ? "n/a" : v.toFixed(1));
const ratio = (a, b) => (a == null || b == null ? "n/a" : (a / b).toFixed(2) + "x");
const kib = (n) => `${n / 1024} KiB`;
const modes = chr?.webgl_available ? ["webgl", "dom"] : chr ? ["dom"] : [];
const names = { mixed: "mixed (PERF.md synthetic)", ascii: "plain ASCII lines", sgr: "heavy SGR colour", repaint: "cursor-addressed full-screen repaint", wide: "wide / emoji text" };

const out = [];
out.push(`## Terminal comparison: ${label}`, "");
out.push(
  `Grid 80x24, scrollback 10,000, 8 MiB per stream, medians of 3 runs (Chromium: 1 run). ` +
    `xterm.js headless ${head?.version ?? "?"} on Node ${head?.node ?? "?"}, Unicode ${head?.unicode ?? "?"}; ` +
    `Chromium ${chr?.chromium ?? "not run"}; ` +
    (chr ? (chr.webgl_available ? "WebGL addon active through software GL (SwiftShader), DOM renderer also run (it is what the app uses today)." : `WebGL addon NOT available on this runner (${chr.webgl_error ?? "no canvas"}); default DOM renderer only.`) : "Chromium rows missing.") ,
  ""
);
out.push("### Throughput (MiB/s, higher is better)", "");
const hdr = ["stream", "write", "xterm headless (Node)", ...modes.map((m) => `xterm Chromium (${m})`), "ours (Screen::advance)", "ours / headless", ...(modes[0] ? [`ours / Chromium (${modes[0]})`] : [])];
out.push(`| ${hdr.join(" | ")} |`, `| ${hdr.map(() => "---").join(" | ")} |`);
for (const s of STREAMS)
  for (const w of WRITE_SIZES) {
    const h = find(head, s, w), o = find(ours, s, w);
    const cs = modes.map((m) => find(chr, s, w, m));
    out.push(`| ${[names[s], kib(w), f(h), ...cs.map(f), f(o), ratio(o, h), ...(modes[0] ? [ratio(o, cs[0])] : [])].join(" | ")} |`);
  }
out.push("");
out.push("### Memory after 100,000 scrollback lines at 80 columns (MiB, lower is better)", "");
out.push("| engine | peak RSS | baseline before filling | growth | ours / this engine (peak) |", "| --- | --- | --- | --- | --- |");
const memRows = [];
if (headMem) memRows.push(["xterm headless (Node process RSS, maxRSS)", headMem.peak_mib, headMem.baseline_mib, headMem.lines_held]);
for (const m of modes) {
  const c = chrMem?.modes?.[m];
  if (c) memRows.push([`xterm Chromium ${m} (all browser processes, sampled every 200 ms)`, c.peak_total_mib, c.baseline_total_mib, c.lines_held]);
  if (c) memRows.push([`xterm Chromium ${m} (renderer process only; JS heap ${c.js_heap_used_mib} MiB via CDP)`, c.peak_renderer_mib, c.baseline_renderer_mib, c.lines_held]);
}
if (oursMem) memRows.push(["ours (Screen, process maxRSS)", oursMem.peak_mib, oursMem.baseline_mib, oursMem.lines_held]);
for (const [n, peak, base, held] of memRows)
  out.push(`| ${n} (${held} lines held) | ${peak.toFixed(1)} | ${base.toFixed(1)} | ${(peak - base).toFixed(1)} | ${n.startsWith("ours") ? "1.00x" : ratio(oursMem?.peak_mib, peak)} |`);
out.push("");
out.push(
  "### What each row measures, and what it does not",
  "",
  "- **xterm headless**: `@xterm/headless` in Node: escape-sequence parsing plus buffer update, nothing else. No DOM, no renderer, no layout. Writes are issued back to back and the harness waits on a write callback whenever 256 KiB are outstanding (waiting on every 4 KiB write would measure Node timer ticks), then on a final callback, so the time covers processing, not just queueing.",
  "- **xterm Chromium**: `@xterm/xterm` in headless Chromium driven by Playwright: the same writes plus the renderer, timed from the first write to two animation frames after the final write callback. It includes whatever the renderer costs, but CI has no real GPU and no display: WebGL (when present) is SwiftShader software GL, and frames are not presented to a screen. Treat it as a CPU-bound lower bound for rendering cost, not as GPU frame pacing. It also runs in a browser engine, not the app's webview.",
  "- **ours**: `canopy-term-core` `Screen::advance` (input filter, parse, combining-mark trim, frame rebuild and row diff on every call), release build, fed from the same files. It includes no rendering at all and no PTY. Because the frame rebuild runs per call, the 4 KiB rows pay that cost 16 times more often than the 64 KiB rows.",
  "- **Ratios** divide ours by the xterm figure on the same row (above 1.00x means ours is faster). Ours/headless compares parse-and-buffer work to parse-and-buffer-plus-frame work. Ours/Chromium compares ours with no renderer against xterm with one, so it favours ours by construction. Neither is an end-to-end comparison of the native app against the app's terminal.",
  "- **Memory**: peak resident set size after feeding 100,000 lines of 76 columns with scrollback set to 100,000. Node and ours use the process `maxRSS`. Chromium has no per-tab RSS in CDP, so RSS is summed from `ps` over every descendant process of the harness, sampled every 200 ms (a sampled peak can miss a spike), and over renderer processes only; the whole-browser sum double counts shared pages. Runtime baselines differ (Node, Chromium, a Rust binary), which is why the baseline and growth columns are shown.",
  "- **Not measured here**: input-to-screen latency, real GPU frame pacing, scrolling smoothness, idle CPU, PTY and process-spawn cost, font shaping and glyph atlas cost in the native renderer, and the app's webview (WKWebView / WebKitGTK) behaviour. See `bench/terminal-compare/MANUAL.md`.",
  ""
);
console.log(out.join("\n"));

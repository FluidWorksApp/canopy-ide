// xterm.js rendering in headless Chromium (Playwright).
//   node chromium.mjs throughput <streams-dir> <out.json>
//   node chromium.mjs mem <out.json>
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STREAMS, WRITE_SIZES, COLS, ROWS, SCROLLBACK, MEM_LINES, saveJson, MIB } from "./common.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = (n) => dirname(require.resolve(`${n}/package.json`));
const xterm = pkgDir("@xterm/xterm");
const VENDOR = {
  "/vendor/xterm.js": join(xterm, "lib/xterm.js"),
  "/vendor/xterm.css": join(xterm, "css/xterm.css"),
  "/vendor/addon-webgl.js": join(pkgDir("@xterm/addon-webgl"), "lib/addon-webgl.js"),
  "/vendor/addon-unicode11.js": join(pkgDir("@xterm/addon-unicode11"), "lib/addon-unicode11.js"),
};
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".bin": "application/octet-stream" };

function serve(streamsDir) {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    let file = null;
    if (url === "/") file = join(here, "page.html");
    else if (VENDOR[url]) file = VENDOR[url];
    else if (/^\/streams\/[a-z]+\.bin$/.test(url)) file = join(streamsDir ?? "", url.slice(9));
    if (!file || !existsSync(file)) { res.writeHead(404).end(); return; }
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "text/plain" }).end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// Software GL: SwiftShader through ANGLE. Without it a runner has no GL at all.
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

async function open(server) {
  const browser = await chromium.launch({ args: ARGS });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return { browser, page };
}

/** Sum RSS (MiB) of every descendant of this process, and of renderers only. */
function rssTree() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], { encoding: "utf8" });
  const procs = out.split("\n").filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m && { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] };
  }).filter(Boolean);
  const mine = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; }
  }
  mine.delete(process.pid);
  const tree = procs.filter((p) => mine.has(p.pid));
  const sum = (l) => l.reduce((a, p) => a + p.rss, 0) / 1024;
  return { total: sum(tree), renderer: sum(tree.filter((p) => p.args.includes("--type=renderer"))), n: tree.length };
}

async function probe(page) {
  return await page.evaluate(() => window.setup("webgl", 80, 24, 1000));
}

async function throughput(dir, out) {
  const server = await serve(dir);
  const { browser, page } = await open(server);
  const version = browser.version();
  const gl = await probe(page);
  const modes = gl.renderer === "webgl" ? ["webgl", "dom"] : ["dom"];
  console.error(`chromium ${version}: webgl ${gl.renderer === "webgl" ? "available (software GL)" : "NOT available: " + (gl.error ?? "no canvas")}`);
  const rows = [];
  for (const mode of modes) {
    for (const stream of STREAMS) {
      for (const size of WRITE_SIZES) {
        const info = await page.evaluate(([m]) => window.setup(m, 80, 24, 10000), [mode, COLS, ROWS, SCROLLBACK]);
        // Untimed warm-up on the first stream pass only.
        const r = await page.evaluate(([n, s]) => window.runStream(n, s), [stream, size]);
        const mibs = r.bytes / MIB / (r.ms / 1000);
        console.error(`chromium/${info.renderer} ${stream} ${size}: ${mibs.toFixed(1)} MiB/s (${r.frames} frames)`);
        rows.push({ mode, renderer: info.renderer, stream, write: size, bytes: r.bytes, ms: +r.ms.toFixed(1), frames: r.frames, mibs: +mibs.toFixed(3) });
      }
    }
  }
  await browser.close();
  server.close();
  saveJson(out, { engine: "xterm-chromium", chromium: version, webgl_available: gl.renderer === "webgl", webgl_error: gl.error ?? null, rows });
}

async function mem(out) {
  const server = await serve(null);
  const result = { engine: "xterm-chromium", modes: {} };
  const probeRun = await open(server);
  const webgl = (await probe(probeRun.page)).renderer === "webgl";
  await probeRun.browser.close();
  for (const mode of webgl ? ["webgl", "dom"] : ["dom"]) {
    const { browser, page } = await open(server);
    const info = await page.evaluate(([m]) => window.setup(m, 80, 24, 100000), [mode]);
    await page.evaluate(() => window.fillLines(50, " x\r\n"));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const base = rssTree();
    let peak = base;
    const timer = setInterval(() => {
      try {
        const s = rssTree();
        if (s.total > peak.total) peak = { ...peak, total: s.total };
        if (s.renderer > peak.renderer) peak = { ...peak, renderer: s.renderer };
      } catch {}
    }, 200);
    const line = " lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\r\n";
    const held = await page.evaluate(([n, l]) => window.fillLines(n, l), [MEM_LINES + ROWS, line]);
    clearInterval(timer);
    const end = rssTree();
    const heap = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    result.modes[info.renderer] = {
      lines_held: held,
      baseline_total_mib: +base.total.toFixed(2),
      peak_total_mib: +Math.max(peak.total, end.total).toFixed(2),
      baseline_renderer_mib: +base.renderer.toFixed(2),
      peak_renderer_mib: +Math.max(peak.renderer, end.renderer).toFixed(2),
      js_heap_used_mib: +(heap.JSHeapUsedSize / MIB).toFixed(2),
    };
    console.error(`chromium/${info.renderer} mem:`, JSON.stringify(result.modes[info.renderer]));
    await browser.close();
  }
  server.close();
  saveJson(out, result);
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "throughput") await throughput(a, b);
else if (mode === "mem") await mem(a);
else {
  console.error("usage: chromium.mjs throughput <dir> <out> | mem <out>");
  process.exit(2);
}

// xterm.js headless in Node: parse + buffer only, no renderer, no DOM.
//   node headless.mjs throughput <streams-dir> <out.json>
//   node headless.mjs mem <out.json>
import { createRequire } from "node:module";
import {
  STREAMS, WRITE_SIZES, COLS, ROWS, SCROLLBACK, WINDOW_BYTES, MEM_LINES,
  loadStream, saveJson, median, MIB, memLine,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { Unicode11Addon } = require("@xterm/addon-unicode11");
const version = require("@xterm/headless/package.json").version;

function makeTerm(scrollback) {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback, allowProposedApi: true });
  // The app loads Unicode11 too, so wide/emoji text uses the same width tables.
  let unicode = "default";
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    unicode = term.unicode.activeVersion;
  } catch (e) {
    unicode = `addon failed: ${e.message}`;
  }
  return { term, unicode };
}

const write = (term, chunk) => new Promise((r) => term.write(chunk, r));

/** Feed `chunks`, waiting on a write callback whenever WINDOW_BYTES are outstanding. */
async function feed(term, data, size) {
  let outstanding = 0;
  for (let off = 0; off < data.length; off += size) {
    const chunk = data.subarray(off, Math.min(off + size, data.length));
    outstanding += chunk.length;
    if (outstanding >= WINDOW_BYTES) {
      await write(term, chunk);
      outstanding = 0;
    } else {
      term.write(chunk);
    }
  }
  await write(term, new Uint8Array(0)); // drain: callbacks fire in order
}

async function throughput(dir, out) {
  const rows = [];
  let unicode = "";
  for (const name of STREAMS) {
    const data = loadStream(dir, name);
    const mib = data.length / MIB;
    for (const size of WRITE_SIZES) {
      const warm = makeTerm(SCROLLBACK);
      await feed(warm.term, data.subarray(0, 1 << 20), size);
      warm.term.dispose();
      const rates = [];
      for (let i = 0; i < 3; i++) {
        const { term, unicode: u } = makeTerm(SCROLLBACK);
        unicode = u;
        const t = performance.now();
        await feed(term, data, size);
        rates.push(mib / ((performance.now() - t) / 1000));
        term.dispose();
      }
      const m = median(rates);
      console.error(`headless ${name} ${size}: ${m.toFixed(1)} MiB/s`);
      rows.push({ stream: name, write: size, bytes: data.length, mibs: +m.toFixed(3) });
    }
  }
  saveJson(out, { engine: "xterm-headless", version, unicode, node: process.version, rows });
}

async function mem(out) {
  const baseline = process.resourceUsage().maxRSS / 1024; // KiB -> MiB
  const { term } = makeTerm(MEM_LINES);
  let buf = "";
  for (let i = 0; i < MEM_LINES + ROWS; i++) {
    buf += memLine(i);
    if (buf.length > 60 * 1024) {
      await write(term, buf);
      buf = "";
    }
  }
  await write(term, buf);
  const held = term.buffer.active.length - ROWS;
  const peak = process.resourceUsage().maxRSS / 1024;
  console.error(`headless mem: baseline ${baseline.toFixed(1)} MiB, peak ${peak.toFixed(1)} MiB, ${held} scrollback lines`);
  saveJson(out, { engine: "xterm-headless", lines_held: held, baseline_mib: +baseline.toFixed(2), peak_mib: +peak.toFixed(2) });
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "throughput") await throughput(a, b);
else if (mode === "mem") await mem(a);
else {
  console.error("usage: headless.mjs throughput <dir> <out> | mem <out>");
  process.exit(2);
}

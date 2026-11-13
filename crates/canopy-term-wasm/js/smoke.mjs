// The wasm build answers the basics the tab relies on.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require(resolve(process.argv[2], "canopy_term_wasm.js"));
const { Terminal } = pkg;
const wasmBytes = () => pkg.__wasm?.memory?.buffer.byteLength ?? process.memoryUsage().arrayBuffers;
const enc = new TextEncoder();

const t = new Terminal(40, 5, 100);
t.advance(enc.encode("hello \x1b[38;2;1;2;3mworld\x1b[0m\r\n\x1b]0;tab title\x07\x1b[6n"));
t.refresh();
assert.equal(t.text().split("\n")[0], "hello world");
assert.equal(t.title(), "tab title");
const cells = t.cells();
assert.equal(cells.length, 40 * 5 * 6);
assert.equal(cells[6 * 6], "w".codePointAt(0));
assert.equal(cells[6 * 6 + 1], 0x02010203, "truecolour foreground");
assert.equal(new TextDecoder().decode(t.take_replies()), "\x1b[2;1R", "cursor position report");

t.advance(enc.encode("\x07\x1b]133;A\x07"));
assert.deepEqual(JSON.parse(t.take_events()).map((e) => e.t), ["bell", "prompt"]);

for (let i = 0; i < 300; i++) t.advance(enc.encode(`line ${i}\r\n`));
t.refresh();
assert.equal(t.scrollback_len(), 100, "scrollback capped at 100 lines");
assert.match(t.scrollback_text(99, 1)[0], /^line \d+$/);

t.resize(20, 4);
t.refresh();
assert.equal(t.cols(), 20);
assert.equal(t.rows(), 4);

const snap = t.snapshot();
const r = Terminal.restore(20, 4, snap);
r.refresh();
assert.equal(r.text(), t.text(), "snapshot restores the visible screen");

const before = wasmBytes();
const many = Array.from({ length: 20 }, () => new Terminal(120, 40, 10_000));
for (const m of many) for (let i = 0; i < 2000; i++) m.advance(enc.encode(`${i} ${"x".repeat(100)}\r\n`));
console.log(`20 terminals x 2000 lines: +${((wasmBytes() - before) / 1048576).toFixed(1)} MiB wasm memory`);
many.forEach((m) => m.free());
console.log("smoke ok");

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

// Input encoders follow the modes the program set.
const k = new Terminal(80, 24, 0);
const dec = (b) => new TextDecoder().decode(b);
k.refresh();
assert.equal(dec(k.encode_key("Up", 0, 0, "", 0, 0)), "\x1b[A");
assert.equal(dec(k.encode_key("c", 4, 0, "", 0, 0)), "\x03", "ctrl+c");
assert.equal(dec(k.encode_key("a", 0, 0, "a", 0, 0)), "a");
assert.equal(dec(k.encode_key("NoSuchKey", 0, 0, "", 0, 0)), "");
assert.equal(dec(k.encode_paste("a\nb\x1b[201~", true)), "a\rb[201~");
assert.equal(dec(k.encode_mouse(0, 0, 2, 3, 0)), "", "mouse off");
assert.equal(dec(k.encode_focus(true)), "");
k.advance(enc.encode("\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h"));
k.refresh();
assert.equal(dec(k.encode_key("Up", 0, 0, "", 0, 0)), "\x1bOA", "application cursor keys");
assert.equal(dec(k.encode_paste("a\nb", true)), "\x1b[200~a\nb\x1b[201~");
assert.equal(dec(k.encode_mouse(0, 0, 2, 3, 0)), "\x1b[<0;3;4M");
assert.equal(dec(k.encode_mouse(1, 0, 2, 3, 0)), "\x1b[<0;3;4m");
assert.equal(dec(k.encode_mouse(0, 5, 0, 0, 0)), "\x1b[<65;1;1M", "wheel down");
assert.equal(dec(k.encode_focus(true)), "\x1b[I");
k.free();

const before = wasmBytes();
const many = Array.from({ length: 20 }, () => new Terminal(120, 40, 10_000));
for (const m of many) for (let i = 0; i < 2000; i++) m.advance(enc.encode(`${i} ${"x".repeat(100)}\r\n`));
console.log(`20 terminals x 2000 lines: +${((wasmBytes() - before) / 1048576).toFixed(1)} MiB wasm memory`);
many.forEach((m) => m.free());
console.log("smoke ok");

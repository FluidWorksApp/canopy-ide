// Wasm half of the parity check. Usage:
//   node js/parity.mjs <pkg dir from wasm-bindgen --target nodejs> <native digests file>
// Feeds each stream exactly as examples/digest.rs does and fails on any
// digest that differs, then prints throughput per stream.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [pkgDir, nativeFile] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { Terminal } = require(resolve(pkgDir, "canopy_term_wasm.js"));

const native = new Map(
  readFileSync(nativeFile, "utf8").trim().split("\n").map((l) => {
    const i = l.lastIndexOf(" ");
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);

let failed = 0;
const rows = [];
for (const [file, want] of native) {
  const bytes = new Uint8Array(readFileSync(file));
  const t = new Terminal(80, 24, 10_000);
  const t0 = performance.now();
  for (let i = 0; i < bytes.length; i += 4096) {
    t.advance(bytes.subarray(i, i + 4096));
    t.take_replies();
  }
  const got = t.digest();
  const ms = performance.now() - t0;
  const ok = got === want;
  if (!ok) failed++;
  rows.push(`| ${file.split("/").pop()} | ${(bytes.length / 1048576).toFixed(2)} MiB | ${ms.toFixed(0)} ms | ${(bytes.length / 1048576 / (ms / 1000)).toFixed(1)} MiB/s | ${ok ? "same" : `DIFFERS (native ${want}, wasm ${got})`} |`);
  t.free();
}
console.log("| stream | size | wasm time (incl. digest) | wasm MiB/s | vs native |\n| --- | --- | --- | --- | --- |\n" + rows.join("\n"));
if (failed) {
  console.error(`${failed} stream(s) differ between the native and the wasm engine`);
  process.exit(1);
}

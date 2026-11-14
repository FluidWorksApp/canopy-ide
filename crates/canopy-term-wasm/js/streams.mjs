// Deterministic byte streams for the parity check and the timing run.
// Each exercises a different part of the engine; none depends on a shell.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Small LCG so every run (and every machine) makes the same bytes.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const enc = new TextEncoder();
const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".split(" ");

export const STREAMS = {
  // Plain log lines that scroll far past the screen.
  ascii(r) {
    let s = "";
    for (let i = 0; i < 40000; i++) s += `${String(i).padStart(6, "0")} ${words[Math.floor(r() * words.length)]} ok status=200\r\n`;
    return s;
  },
  // SGR churn: 16/256/truecolour, bold, italic, underline styles, inverse.
  sgr(r) {
    let s = "";
    for (let i = 0; i < 20000; i++) {
      const pick = Math.floor(r() * 6);
      if (pick === 0) s += `\x1b[3${i % 8}m`;
      else if (pick === 1) s += `\x1b[38;5;${Math.floor(r() * 256)}m`;
      else if (pick === 2) s += `\x1b[48;2;${Math.floor(r() * 256)};${Math.floor(r() * 256)};${Math.floor(r() * 256)}m`;
      else if (pick === 3) s += `\x1b[1;3;4:${1 + Math.floor(r() * 5)}m\x1b[58;5;${Math.floor(r() * 256)}m`;
      else if (pick === 4) s += "\x1b[7m";
      else s += "\x1b[0m";
      s += words[i % words.length] + (i % 9 === 0 ? "\r\n" : " ");
    }
    return s + "\x1b[0m";
  },
  // Full-screen TUI repaint on the alternate screen, cursor addressing, erase.
  repaint(r) {
    let s = "\x1b[?1049h\x1b[?25l";
    for (let f = 0; f < 400; f++) {
      s += "\x1b[H";
      for (let row = 1; row <= 24; row++) s += `\x1b[${row};1H\x1b[2K\x1b[3${(f + row) % 8}m frame ${f} row ${row} ${"#".repeat(Math.floor(r() * 60))}`;
      s += `\x1b[${1 + Math.floor(r() * 24)};${1 + Math.floor(r() * 80)}H\x1b[K`;
    }
    return s + "\x1b[0m\x1b[?25h\x1b[?1049l";
  },
  // Wide characters, emoji clusters, combining marks, wrapping.
  wide(r) {
    const bits = ["漢字", "かな", "한글", "👍🏽", "👨‍👩‍👧", "é", "🇸🇬", "ｗｉｄｅ", "ascii"];
    let s = "";
    for (let i = 0; i < 15000; i++) s += bits[Math.floor(r() * bits.length)] + (i % 13 === 0 ? "\r\n" : "");
    return s;
  },
  // Scroll regions, insert/delete line and char, tabs, OSC title, OSC 8, OSC 133, modes.
  control(r) {
    let s = "\x1b]0;parity title\x07\x1b[?1h\x1b[?2004h\x1b[?1006h\x1b[?1002h";
    for (let i = 0; i < 3000; i++) {
      s += "\x1b]133;A\x07$ \x1b]133;B\x07cmd " + i + "\r\n\x1b]133;C\x07";
      s += `\x1b[${2 + (i % 5)};${20 - (i % 5)}r\x1b[${3 + (i % 3)}H\x1b[${1 + (i % 2)}L\x1b[2M\x1b[3@x\x1b[2P\x1b[r`;
      s += `\tcol\ttab\x1b]8;;https://example.com/${i}\x07link${i}\x1b]8;;\x07\r\n`;
      s += `\x1b]133;D;${i % 3}\x07`;
      if (r() < 0.05) s += "\x1b[?1049h alt \x1b[?1049l";
    }
    return s;
  },
};

export function makeStreams(dir) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [name, gen] of Object.entries(STREAMS)) {
    const file = join(dir, `${name}.bin`);
    writeFileSync(file, enc.encode(gen(rng(name.length * 7919))));
    files.push(file);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of makeStreams(process.argv[2] ?? "streams")) console.log(f);
}

// Settings > Terminal > Show engine stats: a small badge on each terminal
// saying which engine draws it and what that costs. Numbers only, never
// terminal content.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSettings, subscribeSettings } from "../settings";
import { ghosttyMemoryBytes, type TerminalStats } from "../terminalEngine";

const FALLBACK_TEXT: Record<string, string> = {
  "not-loaded": "engine still loading",
  "load-failed": "engine failed to load",
  "load-timeout": "engine failed to load",
  "no-webassembly": "no WebAssembly here",
  "engine-trap": "engine failed",
  "out-of-memory": "engine out of memory",
  "create-failed": "engine failed to start",
};

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

export function statsLines(
  stats: TerminalStats,
  previous: { bytes: number; paints: number; parseMs: number; paintMs: number },
  seconds: number,
  engineMemory: number,
): string[] {
  const name = stats.engine === "ghostty" ? "Ghostty" : "Classic (xterm)";
  const why = stats.fallback ? ` · ${FALLBACK_TEXT[stats.fallback] ?? stats.fallback}` : "";
  const lines = [
    `${name}${why}`,
    `${stats.cols}×${stats.rows} · ${stats.scrollbackRows.toLocaleString()} lines back`,
  ];
  const rate = seconds > 0 ? (stats.bytes - previous.bytes) / seconds : 0;
  const output = `out ${rate >= 1048576 ? `${(rate / 1048576).toFixed(1)} MB/s` : `${Math.round(rate / 1024)} KB/s`}`;
  if (stats.engine === "ghostty") {
    // Over the last sample only: a lifetime average swings with every
    // keystroke echo and freezes at idle. No parsing in the window is "idle",
    // not a stale number.
    const parsedMs = stats.parseMs - previous.parseMs;
    const parse = parsedMs > 0 ? (stats.bytes - previous.bytes) / 1048576 / (parsedMs / 1000) : 0;
    const frames = stats.paints - previous.paints;
    const paintAvg = frames > 0 ? (stats.paintMs - previous.paintMs) / frames : 0;
    const fps = seconds > 0 ? Math.round(frames / seconds) : 0;
    lines.push(
      `${output} · parses ${parsedMs > 0 ? `${parse >= 100 ? Math.round(parse) : parse.toFixed(1)} MB/s` : "idle"}`,
    );
    lines.push(
      frames > 0
        ? `paint ${paintAvg.toFixed(1)} ms avg, ${stats.lastPaintMs.toFixed(1)} last · ${fps} paints/s`
        : "paint idle",
    );
    lines.push(`engine memory ${megabytes(engineMemory)}, all terminals`);
    if (stats.recoveries) lines.push(`engine rebuilt ${stats.recoveries}×`);
  } else {
    lines.push(output);
  }
  return lines;
}

export function TerminalEngineStats({ stats }: { stats: TerminalStats | null }) {
  const on = useSyncExternalStore(subscribeSettings, () => getSettings().terminalEngineStats);
  const [, setTick] = useState(0);
  const previous = useRef({ bytes: 0, paints: 0, parseMs: 0, paintMs: 0, at: 0 });
  const shown = useRef<string[]>([]);
  useEffect(() => {
    if (!on || !stats) return;
    const sample = () => {
      const now = performance.now();
      const last = previous.current;
      shown.current = statsLines(stats, last, last.at ? (now - last.at) / 1000 : 0, ghosttyMemoryBytes());
      previous.current = {
        bytes: stats.bytes,
        paints: stats.paints,
        parseMs: stats.parseMs,
        paintMs: stats.paintMs,
        at: now,
      };
      setTick((n) => n + 1);
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [on, stats]);
  if (!on || !stats) return null;
  return (
    <div className="term-engine-stats" aria-hidden="true">
      {shown.current.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

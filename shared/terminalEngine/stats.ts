// Live numbers for the developer overlay (Settings > Terminal > Show engine
// stats): which engine each open terminal runs on and what it costs. Counts
// and timings only, never terminal content.

export interface TerminalStats {
  engine: "ghostty" | "xterm";
  /** Why this terminal is not on the preferred engine; "" when it is. */
  fallback: string;
  cols: number;
  rows: number;
  scrollbackRows: number;
  /** Bytes of output parsed, and the time the engine spent parsing them. */
  bytes: number;
  parseMs: number;
  /** Frames painted, total paint time, and the last frame's cost. */
  paints: number;
  paintMs: number;
  lastPaintMs: number;
  lastPaintRows: number;
  /** Times the engine was rebuilt after a failure. */
  recoveries: number;
}

export function newStats(engine: TerminalStats["engine"], fallback = ""): TerminalStats {
  return {
    engine,
    fallback,
    cols: 0,
    rows: 0,
    scrollbackRows: 0,
    bytes: 0,
    parseMs: 0,
    paints: 0,
    paintMs: 0,
    lastPaintMs: 0,
    lastPaintRows: 0,
    recoveries: 0,
  };
}

const live = new Set<TerminalStats>();

export function trackStats(stats: TerminalStats): () => void {
  live.add(stats);
  return () => live.delete(stats);
}

export function liveStats(): TerminalStats[] {
  return [...live];
}

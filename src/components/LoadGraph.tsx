// The status bar's resource readout: a tiny CPU and memory graph, like a
// system activity monitor's, instead of a line of numbers. The numbers are in
// its tooltip and in the breakdown it opens.
export interface LoadPoint {
  cpu: number | null;
  mem: number | null;
}

const W = 40;
const H = 14;

function line(points: readonly LoadPoint[], key: keyof LoadPoint, slots: number): string {
  const step = W / Math.max(1, slots - 1);
  const offset = slots - points.length;
  return points
    .map((p, i) => (p[key] == null ? null : `${((offset + i) * step).toFixed(1)},${(H - 1 - p[key]! * (H - 2)).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
}

export function LoadGraph({
  points,
  slots,
  tone,
}: {
  points: readonly LoadPoint[];
  slots: number;
  /** Colour for a shortage: memory or CPU running out. */
  tone?: "low" | "critical";
}) {
  const last = points[points.length - 1];
  const pct = (x: number | null | undefined) => (x == null ? "unknown" : `${Math.round(x * 100)}%`);
  return (
    <svg
      className={`load-graph${tone ? ` is-${tone}` : ""}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`CPU ${pct(last?.cpu)}, memory ${pct(last?.mem)}`}
    >
      <polyline className="load-graph-mem" points={line(points, "mem", slots)} />
      <polyline className="load-graph-cpu" points={line(points, "cpu", slots)} />
    </svg>
  );
}

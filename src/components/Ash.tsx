// Ash, drawn. The favicon's canopy arc is the brow, the prompt's underscore is
// the mouth, and the chevron stays a cursor — so Ash at rest is the mark, and
// every other state is the mark moving. Geometry and the size ladder live in
// ../ash; this file only turns them into SVG.
import { useSyncExternalStore } from "react";
import {
  ASH_TONE_VARS,
  ashArcPath,
  ashMetrics,
  ashTone,
  type AshState,
  type AshTone,
} from "../ash";

interface AshProps {
  state: AshState;
  /** Rendered box in px. Drives the whole ladder — see ashMetrics. */
  size?: number;
  /** Overrides the state's own colour, for a lifecycle Canopy reads
   *  differently from the face (a lost agent wears `sleeping` in warn). */
  tone?: AshTone;
  /** The agent's own colour, when one is talking. Beats `tone`. */
  hue?: string;
  title?: string;
  className?: string;
}

const INK = "var(--text)";
const INK_DIM = "var(--text-dim)";

const visibility = new Set<() => void>();
let watching = false;

function watchVisibility(fn: () => void) {
  visibility.add(fn);
  if (!watching && typeof document !== "undefined") {
    watching = true;
    document.addEventListener("visibilitychange", () => {
      for (const l of [...visibility]) l();
    });
  }
  return () => {
    visibility.delete(fn);
  };
}

const documentVisible = () => typeof document === "undefined" || !document.hidden;

export function Ash({ state, size = 24, tone, hue, title, className }: AshProps) {
  const visible = useSyncExternalStore(watchVisibility, documentVisible, () => true);
  const m = ashMetrics(size);
  const colour = hue ?? ASH_TONE_VARS[tone ?? ashTone(state)];
  const eyeInk = m.monochrome ? "currentColor" : INK;
  const { r, cy, dx } = m.eye;

  const parts: React.ReactNode[] = [];
  const eyes = (leftX: number, rightX: number, y: number, rad: number) => [
    <circle key="el" cx={leftX} cy={y} r={rad} fill={eyeInk} />,
    <circle key="er" cx={rightX} cy={y} r={rad} fill={eyeInk} />,
  ];
  const stroke = (key: string, d: string, s: string, w = 2.6, extra?: object) => (
    <path
      key={key}
      d={d}
      fill="none"
      stroke={s}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...extra}
    />
  );

  const plainArc = stroke("arc", ashArcPath(m.arc), "currentColor", m.stroke);
  const plainEyes = eyes(20 - dx, 20 + dx, cy, r);

  if (!m.expressive) {
    parts.push(plainArc, ...plainEyes);
  } else if (state === "thinking") {
    parts.push(
      plainArc,
      ...eyes(20 - dx + 1.2, 20 + dx + 1.2, cy - 0.6, r),
      stroke("chevron", "M14.4 31.4l3 2.6-3 2.6", "currentColor"),
      stroke("cursor", "M21 36.6h5.6", "currentColor", 2.6, { className: "ash-cursor" }),
    );
  } else if (state === "done" || state === "celebrating") {
    if (state === "celebrating")
      parts.push(
        stroke("sparks", "M6.6 8.4l2 3M20 4.6v3.4M33.4 8.4l-2 3", "currentColor", 2.4, {
          className: "ash-sparks",
        }),
      );
    parts.push(
      plainArc,
      stroke("el", "M12.8 27c1.2-2.6 4-2.6 5.2 0", INK),
      stroke("er", "M22 27c1.2-2.6 4-2.6 5.2 0", INK),
    );
    if (state === "celebrating")
      parts.push(<ellipse key="mouth" cx={20} cy={33.2} rx={3.4} ry={2.6} fill={INK_DIM} />);
    else if (m.mouth) parts.push(stroke("mouth", "M16.2 32.6h7.6", INK_DIM));
  } else if (state === "needs") {
    parts.push(
      stroke("arc", "M7.4 18.8 A12.6 12.6 0 0 1 32.6 18.8", "currentColor", m.stroke),
      ...eyes(20 - dx, 20 + dx, cy, r + 0.7),
    );
    if (m.mouth) parts.push(stroke("mouth", "M16.2 33.4h7.6", "currentColor"));
  } else if (state === "blocked") {
    parts.push(
      stroke("arcl", "M8.8 19.6 A11.2 11.2 0 0 1 15.8 11", "currentColor", m.stroke),
      stroke("arcr", "M24.2 11 A11.2 11.2 0 0 1 31.2 19.6", "currentColor", m.stroke),
      stroke("xl", "M13.8 24.2l3.2 3.2M17 24.2l-3.2 3.2", INK, 2.5),
      stroke("xr", "M23 24.2l3.2 3.2M26.2 24.2l-3.2 3.2", INK, 2.5),
    );
    if (m.mouth) parts.push(stroke("mouth", "M16.2 33h7.6", "currentColor"));
  } else if (state === "sleeping") {
    parts.push(
      stroke("arc", "M8.4 21.4 A14 14 0 0 1 31.6 21.4", "currentColor", m.stroke, {
        opacity: 0.45,
      }),
      stroke("el", "M13.2 26.4h4.4", INK, 2.6, { opacity: 0.6 }),
      stroke("er", "M22.4 26.4h4.4", INK, 2.6, { opacity: 0.6 }),
      <text
        key="z"
        x={31}
        y={14}
        fill="currentColor"
        className="ash-z"
        fontSize={7}
        fontWeight={700}
      >
        z
      </text>,
    );
    if (m.mouth) parts.push(stroke("mouth", "M16.2 32.6h7.6", INK_DIM, 2.6, { opacity: 0.5 }));
  } else if (state === "explaining") {
    parts.push(
      stroke("arc", "M7.2 19.6 A11.2 11.2 0 0 1 29.6 19.6", "currentColor", m.stroke),
      ...eyes(20 - dx, 20 + dx - 0.6, cy, r),
      stroke("point", "M31.4 22.6l3.2 3.4-3.2 3.4", "currentColor", 2.6, {
        className: "ash-point",
      }),
    );
    if (m.mouth) parts.push(stroke("mouth", "M14.6 32.6h7.6", INK_DIM));
  } else {
    parts.push(
      plainArc,
      <g key="eyes" className="ash-blink">
        {plainEyes}
      </g>,
    );
    if (m.mouth) parts.push(stroke("mouth", "M16.2 32.6h7.6", INK_DIM));
  }

  // "Never animates on a background tab" — and the smallest tier stays still
  // altogether, except for the one pulse that says a turn is still alive.
  const motion = !visible
    ? ""
    : m.expressive
      ? ` ash-anim ash-anim-${state}`
      : state === "thinking"
        ? " ash-alive"
        : "";

  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={`ash${motion}${className ? ` ${className}` : ""}`}
      style={{ color: colour }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {parts}
    </svg>
  );
}

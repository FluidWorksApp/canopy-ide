// Recording-pill visualisers, ported from SuprFlow's SwiftUI Canvas renderers
// (Views/RecordingOverlayView.swift) to plain 2D canvas.
//
// Each renderer is a pure function of (context, size, level, phase): no state,
// no allocation per frame beyond gradients, so the whole set can run off one
// shared rAF loop in Dictation.tsx. `level` is already smoothed and normalised
// to 0..1 by the caller; `phase` is a monotonically rising number the caller
// advances each frame, which is what makes the waves travel.
import { THEME_CHANGE_EVENT, type DictationWaveStyle } from "./settings";

export interface WaveFrame {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels, not device pixels — the caller has already applied the DPR
   *  transform, so renderers work in layout units. */
  w: number;
  h: number;
  /** 0..1, smoothed. */
  level: number;
  /** Radians-ish; advances ~0.08 per frame at 60fps, as in SuprFlow. */
  phase: number;
}

// SuprFlow's visualisers use one fixed indigo→magenta→coral ramp, because it
// only ever has to sit on its own black pill. Canopy's pill sits inside a
// themed app whose accent the user picked, so the ramp is derived from
// --accent instead: same three-stop gradient shape, rotated onto whatever
// colour is currently in force.

type RGB = [number, number, number];

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 1) + 1) % 1;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/** Resolve --accent to real channel values. Read off a probe element rather
 *  than the custom property directly: the property's value can be a hex, an
 *  rgb(), or a color-mix() the skin composed, and only the cascade knows how
 *  to reduce all of those to numbers. */
function readAccent(): RGB {
  const fallback: RGB = [102, 128, 255];
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;color:var(--accent,#6680ff)";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const m = resolved.match(/(\d+(?:\.\d+)?)/g);
  if (!m || m.length < 3) return fallback;
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/** Three stops around the accent: a cooler, slightly darker end, the accent
 *  itself, and a warmer, brighter end. Enough hue travel to read as a
 *  gradient, little enough that it still reads as the accent colour. */
function buildRamp(): RGB[] {
  const [h, s, l] = rgbToHsl(readAccent());
  // A near-grey accent has no hue worth rotating, and forcing saturation onto
  // it would invent a colour the user did not pick — a grey accent came out
  // blue that way. Give it a wider lightness ramp instead, so it still reads
  // as a gradient while staying grey.
  const neutral = s < 0.12;
  const spread = neutral ? 0 : 0.055;
  const sat = neutral ? s : Math.max(s, 0.35);
  const lift = neutral ? 0.24 : 0.16;
  const drop = neutral ? 0.18 : 0.1;
  return [
    hslToRgb(h - spread, sat, Math.max(0.28, l - drop)),
    hslToRgb(h, sat, Math.min(0.75, Math.max(0.45, l))),
    hslToRgb(h + spread, sat, Math.min(0.88, l + lift)),
  ];
}

let ramp: RGB[] | null = null;

/** Drop the cached ramp so the next frame picks up a new accent. Exported for
 *  tests; in the app the theme-change listener below is what calls it. */
export function invalidateWavePalette() {
  ramp = null;
}

if (typeof window !== "undefined") {
  // Both a skin swap and an accent change fire this.
  window.addEventListener(THEME_CHANGE_EVENT, invalidateWavePalette);
}

/** The accent ramp, sampled by position. */
function rampColor(t: number, alpha = 1): string {
  const stops = (ramp ??= buildRamp());
  const scaled = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

function rampGradient(ctx: CanvasRenderingContext2D, w: number, alpha = 1) {
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, rampColor(0, alpha));
  g.addColorStop(0.5, rampColor(0.5, alpha));
  g.addColorStop(1, rampColor(1, alpha));
  return g;
}

/** Simple animated bars — the default, and the cheapest to draw. A tight
 *  centred cluster rather than bars spread across the full width: spread out,
 *  the quiet frames read as five unrelated dots instead of one meter. */
function classic({ ctx, w, h, level, phase }: WaveFrame) {
  const bars = 5;
  const barW = 4;
  const gap = 4;
  const total = bars * barW + (bars - 1) * gap;
  const x0 = (w - total) / 2;
  const g = ctx.createLinearGradient(x0, 0, x0 + total, 0);
  g.addColorStop(0, rampColor(0));
  g.addColorStop(0.5, rampColor(0.5));
  g.addColorStop(1, rampColor(1));
  ctx.fillStyle = g;
  for (let i = 0; i < bars; i++) {
    // Each bar runs on its own phase so they never pulse in lockstep. abs()
    // keeps every bar lively — a plain sine parks half of them at the floor.
    const wobble = 0.45 + 0.55 * Math.abs(Math.sin(phase * 2 + i * 1.1));
    const hh = Math.max(5, h * (0.25 + level * 0.75 * wobble));
    const x = x0 + i * (barW + gap);
    ctx.beginPath();
    ctx.roundRect(x, (h - hh) / 2, barW, hh, barW / 2);
    ctx.fill();
  }
}

/** Centre-weighted bars with a reflection under the baseline. */
function equalizer({ ctx, w, h, level, phase }: WaveFrame) {
  const bars = 18;
  const barW = Math.max(1.5, (w / bars) * 0.55);
  const step = w / bars;
  const top = h * 0.72;
  for (let i = 0; i < bars; i++) {
    const p = i / (bars - 1);
    // Bell curve across the strip, so the middle is loudest — SuprFlow's
    // stand-in for a real frequency response.
    const d = Math.abs(p - 0.5) * 2;
    const bell = 0.3 + Math.exp(-d * d * 2) * 0.7;
    const wobble = 0.65 + 0.35 * Math.sin(phase * 2.4 + i * 0.7);
    const hh = Math.max(2, top * Math.min(1, 0.12 + level * bell * wobble));
    const x = i * step + (step - barW) / 2;
    ctx.fillStyle = rampColor(p);
    ctx.beginPath();
    ctx.roundRect(x, top - hh, barW, hh, barW / 2);
    ctx.fill();
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.roundRect(x, top + 1, barW, hh * 0.32, barW / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** Three stacked sine layers with dots riding the front one. */
function particle({ ctx, w, h, level, phase }: WaveFrame) {
  const mid = h / 2;
  const pts = 40;
  const at = (nx: number, off: number) =>
    Math.sin(nx * 4 * Math.PI + phase + off) +
    Math.sin(nx * 6 * Math.PI + phase * 1.3 + off) * 0.5 +
    Math.sin(nx * 2 * Math.PI + phase * 0.7 + off) * 0.3;

  for (let layer = 0; layer < 3; layer++) {
    const off = layer * 0.8;
    const alpha = 1 - layer * 0.25;
    const amp = h * 0.35 * Math.max(0.2, level) * (1 - layer * 0.2) * 0.5;
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const nx = i / pts;
      const x = nx * w;
      const y = mid + at(nx, off) * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rampGradient(ctx, w, alpha);
    ctx.lineWidth = 1.5 - layer * 0.3;
    ctx.stroke();

    if (layer === 0) {
      for (let i = 0; i < pts; i += 3) {
        const nx = i / pts;
        const x = nx * w;
        const y = mid + at(nx, off) * amp;
        const r =
          (0.9 + Math.max(0.2, level) * 1.4) *
          (0.7 + Math.sin(phase * 2 + nx * Math.PI) * 0.3);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.4, r), 0, Math.PI * 2);
        ctx.fillStyle = rampColor(nx, 0.9);
        ctx.fill();
      }
    }
  }
}

/** A filled gradient ribbon hanging off the centre line. */
function ribbon({ ctx, w, h, level, phase }: WaveFrame) {
  const mid = h / 2;
  const amp = h * 0.4 * Math.max(0.15, level);
  const pts = 60;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i <= pts; i++) {
    const nx = i / pts;
    const combined =
      (Math.sin(nx * 3 * Math.PI + phase) +
        Math.sin(nx * 5 * Math.PI + phase * 1.2) * 0.4) *
      0.7;
    ctx.lineTo(nx * w, mid + combined * amp);
  }
  ctx.lineTo(w, mid);
  ctx.closePath();
  ctx.fillStyle = rampGradient(ctx, w, 0.85);
  ctx.fill();
}

/** Rings breathing out from the centre. Elliptical, not circular: the pill is
 *  a wide strip, and circles capped to its height would use a third of it. */
function pulse({ ctx, w, h, level, phase }: WaveFrame) {
  const cx = w / 2;
  const cy = h / 2;
  const maxRx = w / 2 - 1;
  const maxRy = h / 2 - 1;
  const squash = maxRy / maxRx;
  for (let ring = 0; ring < 3; ring++) {
    // Each ring is a third of a cycle ahead, so one is always expanding.
    const t = ((phase * 0.3 + ring / 3) % 1 + 1) % 1;
    const rx = maxRx * t * (0.6 + Math.max(0.2, level) * 0.6);
    if (rx < 1) continue;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.min(maxRx, rx), Math.min(maxRy, rx * squash), 0, 0, Math.PI * 2);
    ctx.strokeStyle = rampColor(t, (1 - t) * 0.95);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  const coreRy = Math.max(1.5, maxRy * 0.35 * (0.6 + level));
  ctx.beginPath();
  ctx.ellipse(cx, cy, coreRy / squash, coreRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = rampColor(0.5);
  ctx.fill();
}

/** Two glowing counter-running sines. */
function neon({ ctx, w, h, level, phase }: WaveFrame) {
  const mid = h / 2;
  const amp = h * 0.34 * Math.max(0.18, level);
  for (const dir of [1, -1]) {
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const nx = i / 48;
      const y = mid + Math.sin(nx * 3 * Math.PI + phase * dir) * amp * dir;
      if (i === 0) ctx.moveTo(nx * w, y);
      else ctx.lineTo(nx * w, y);
    }
    ctx.strokeStyle = rampGradient(ctx, w, 0.95);
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8;
    ctx.shadowColor = rampColor(0.5, 0.8);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

const RENDERERS: Record<DictationWaveStyle, (f: WaveFrame) => void> = {
  classic,
  equalizer,
  particle,
  ribbon,
  pulse,
  neon,
};

export function drawWave(style: DictationWaveStyle, frame: WaveFrame) {
  (RENDERERS[style] ?? classic)(frame);
}

/** Turn the backend's raw RMS into the 0..1 the renderers want.
 *
 *  Speech RMS lives around 0.02–0.2, and a linear map of that leaves the
 *  visualiser barely moving. The square root expands the quiet end, where all
 *  the perceptible variation actually is, and the cap keeps a shout from
 *  pinning every bar flat against the top. */
export function normalizeLevel(rms: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.6);
}

/** One-pole smoothing with a fast attack and slow release, so the wave jumps
 *  onto a syllable but glides down after it instead of strobing at 30Hz. */
export function smoothLevel(prev: number, next: number): number {
  const k = next > prev ? 0.55 : 0.12;
  return prev + (next - prev) * k;
}

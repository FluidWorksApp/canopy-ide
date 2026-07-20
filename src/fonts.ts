// Which monospace fonts this machine actually has.
//
// There is no font-enumeration API a WKWebView will answer (queryLocalFonts is
// Chromium-only and permission-gated), so this measures instead: render a
// string in "<candidate>, monospace" and compare its width to the same string
// in plain "monospace". Different width = the candidate resolved to a real
// font. Two baselines are used because a candidate that happens to be
// metrically identical to one fallback would otherwise read as missing.
//
// The candidate list is the point: a text box asking for a CSS font stack is
// unanswerable — nobody knows what is installed, and a typo silently falls
// back with no feedback.

const CANDIDATES = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Roboto Mono",
  "Ubuntu Mono",
  "Hack",
  "Inconsolata",
  "Iosevka",
  "Victor Mono",
  "Geist Mono",
  "Berkeley Mono",
  "Anonymous Pro",
  "Space Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "PT Mono",
  "Andale Mono",
  "Courier New",
  "Consolas",
];

const PROBE = "MMMMMMMMMMlliii0Oo—@#";

function widthIn(ctx: CanvasRenderingContext2D, family: string): number {
  ctx.font = `72px ${family}`;
  return ctx.measureText(PROBE).width;
}

function detect(): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const baselines = ["monospace", "sans-serif"].map((b) => ({
    name: b,
    width: widthIn(ctx, b),
  }));
  return CANDIDATES.filter((font) =>
    // Present if it differs from EVERY baseline: matching one is expected
    // (a mono font measures like monospace), matching all means the
    // candidate never resolved and the baseline itself was drawn.
    baselines.every((b) => widthIn(ctx, `"${font}", ${b.name}`) !== b.width),
  );
}

let cached: string[] | null = null;

/** Installed monospace fonts, measured once per run. */
export function availableMonoFonts(): string[] {
  cached ??= detect();
  return cached;
}

/** The stack a font choice becomes: the pick, then sane fallbacks, so a
 *  font uninstalled later degrades instead of rendering in something
 *  proportional. Empty pick = the app default stack. */
export function fontStack(family: string): string {
  const f = family.trim();
  if (!f) return DEFAULT_STACK;
  // Already a stack (an older setting, or hand-edited) — leave it alone.
  if (f.includes(",")) return f;
  return `"${f}", ${DEFAULT_STACK}`;
}

export const DEFAULT_STACK =
  "'SF Mono', Menlo, Monaco, 'JetBrains Mono', 'Fira Code', monospace";

/** The font name to show as selected for a stored stack. */
export function fontLabel(stored: string): string {
  const s = stored.trim();
  if (!s || s === DEFAULT_STACK) return "";
  const first = s.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return first;
}

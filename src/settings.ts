// Small persistent settings, stored in localStorage. Keep this flat and cheap.
export type Theme = "auto" | "default" | "gotham" | "daylight" | "custom";

/** What "auto" means right now: Default when macOS is in dark mode, Daylight
 *  in light mode. Every consumer of the skin (CSS data-theme, terminal
 *  palettes, Monaco) works off the resolved value — "auto" itself never
 *  reaches them. */
export function resolveTheme(theme: Theme): Exclude<Theme, "auto"> {
  if (theme !== "auto") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "default"
    : "daylight";
}

/** Re-apply the skin when the OS flips day/night while the setting is Auto.
 *  Returns an unsubscribe. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const s = getSettings();
    if (s.theme === "auto") applyTheme("auto", s.customAccent);
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export const THEMES: { id: Theme; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "default", label: "Default" },
  { id: "gotham", label: "Gotham" },
  { id: "daylight", label: "Daylight" },
  { id: "custom", label: "Custom" },
];

/** Shared across Monaco and xterm even though neither uses these names
 *  natively — Monaco calls "bar" "line", xterm doesn't have Monaco's
 *  line-thin/block-outline variants. Personalize.tsx maps to whichever each
 *  engine actually wants. */
export type CursorStyle = "block" | "underline" | "bar";

export const TERMINAL_FONT_DEFAULT =
  "'SF Mono', Menlo, Monaco, 'JetBrains Mono', 'Fira Code', monospace";
export const EDITOR_FONT_DEFAULT =
  "'SF Mono', Menlo, Monaco, 'JetBrains Mono', 'Fira Code', monospace";

export interface Settings {
  scrollback: number;
  /** Terminal font size — kept under its original name for backward compat
   *  with everyone who already has it in localStorage. */
  fontSize: number;
  // Runaway-process guard thresholds (per PTY session process tree)
  runawayCpuPercent: number;
  runawayMemBytes: number;
  ptyHighWater: number;
  /** Per-tracker secrets for the Issue Trackers panel, keyed by provider id
   *  (see src/trackers.ts). Local-only: sent nowhere but the tracker's own
   *  API, straight from this machine. */
  trackerKeys: Record<string, string>;
  theme: Theme;
  /** Highlight color, applied on top of WHATEVER skin is active — a skin
   *  sets the whole palette, the accent is one colour within it, and there
   *  is no reason picking a purple should force you off Daylight. Empty
   *  string means "use the skin's own accent". A luminance-derived
   *  --on-accent rides along so accent-filled buttons stay legible without
   *  the user having to pick a second colour. */
  customAccent: string;

  // ---- Personalize: font + cursor, Editor (Monaco) and Terminal (xterm)
  // independently — different rendering engines, so neither shares the
  // other's font metrics or cursor vocabulary. Applied to newly opened
  // terminals/editor tabs, same as `fontSize`/`scrollback` already were —
  // there's no live-remount of what's already open, consistent with how
  // those two settings have always behaved (no Settings screen has ever
  // pushed a change into an already-open Term/Monaco instance).
  terminalFontFamily: string;
  terminalCursorStyle: CursorStyle;
  terminalCursorBlink: boolean;
  editorFontFamily: string;
  editorFontSize: number;
  editorCursorStyle: CursorStyle;
  editorCursorBlink: boolean;
  /** Which agent CLI starts work on a ticket (registry id in projects.ts).
   *  Was hardcoded to claude, which quietly made every other agent a
   *  second-class citizen in a product built to run all of them. */
  defaultAgent: string;
}

// NB: stored settings override these (see getSettings), so flipping a default
// does nothing for anyone who already has the key in localStorage. A setting
// that must actually change for existing users has to be removed outright —
// which is exactly why `webgl` is gone rather than defaulted to false.
const DEFAULTS: Settings = {
  scrollback: 10_000,
  fontSize: 13,
  runawayCpuPercent: 300,
  runawayMemBytes: 4 * 1024 * 1024 * 1024,
  ptyHighWater: 2 * 1024 * 1024,
  defaultAgent: "claude",
  trackerKeys: {},
  theme: "default",
  customAccent: "",
  terminalFontFamily: TERMINAL_FONT_DEFAULT,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  editorFontFamily: EDITOR_FONT_DEFAULT,
  editorFontSize: 13,
  editorCursorStyle: "bar",
  editorCursorBlink: true,
};

const KEY = "canopy.settings";

export function getSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    const merged = { ...DEFAULTS, ...stored };
    // Accent used to be meaningful only under the "custom" skin, and every
    // install carried the default blue in that field whether or not it was
    // ever chosen. Applying that to every skin now would repaint Gotham's
    // gold blue for people who never asked. So: an accent counts as chosen
    // only if the old model would actually have shown it.
    if (stored.customAccent && stored.theme !== "custom") {
      merged.customAccent = "";
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

/** Relative luminance (WCAG) from a #rrggbb hex string — used to decide
 *  whether text sitting on a filled accent color should be black or white,
 *  so a "Custom" accent stays legible without the user picking two colors. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const [r, g, b] = m.slice(1, 4).map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Event name Term.tsx listens for to recolor already-open terminals live —
 *  everything else picks up a new theme (or a new/cleared/re-dimmed
 *  wallpaper) for free via CSS custom properties, but xterm renders to a
 *  canvas and needs its JS-side theme object pushed explicitly. Dispatched by
 *  applyTheme(). See terminalThemes.ts. */
export const THEME_CHANGE_EVENT = "canopy:theme";

/** Stamps the theme onto <html data-theme="…">, which is all index.css needs
 *  to flip every color: one attribute, not a re-render or a re-mount. Call on
 *  boot and again whenever the theme (or, for "custom", the accent color)
 *  changes. */

export function applyTheme(theme: Theme, customAccent?: string): void {
  document.documentElement.dataset.theme = resolveTheme(theme);
  const root = document.documentElement.style;
  const accent = (customAccent ?? "").trim();
  if (accent) {
    // Orthogonal to the skin: Gotham with a teal accent is a legitimate
    // thing to want, and forcing a skin change to get one was the wrong
    // model.
    root.setProperty("--accent", accent);
    root.setProperty("--on-accent", luminance(accent) > 0.5 ? "#12131c" : "#ffffff");
  } else {
    // No override — fall back to whatever the skin's stylesheet block says.
    root.removeProperty("--accent");
    root.removeProperty("--on-accent");
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

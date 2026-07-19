// Small persistent settings, stored in localStorage. Keep this flat and cheap.
export interface Settings {
  scrollback: number;
  fontSize: number;
  // Runaway-process guard thresholds (per PTY session process tree)
  runawayCpuPercent: number;
  runawayMemBytes: number;
  ptyHighWater: number;
  /** "system" follows the OS day/night setting live. */
  theme: "system" | "dark" | "light";
  /** Key into themes.ts ACCENTS. */
  accent: string;
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
  theme: "dark",
  accent: "blue",
};

const KEY = "canopy.settings";

export function getSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

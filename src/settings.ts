// Small persistent settings, stored in localStorage. Keep this flat and cheap.
export interface Settings {
  scrollback: number;
  webgl: boolean;
  fontSize: number;
  // Runaway-process guard thresholds (per PTY session process tree)
  runawayCpuPercent: number;
  runawayMemBytes: number;
  ptyHighWater: number;
}

const DEFAULTS: Settings = {
  scrollback: 10_000,
  webgl: true,
  fontSize: 13,
  runawayCpuPercent: 300,
  runawayMemBytes: 4 * 1024 * 1024 * 1024,
  ptyHighWater: 2 * 1024 * 1024,
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

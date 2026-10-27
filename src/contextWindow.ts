// How big each model's context window is, as the agent CLI itself reports it.
//
// A transcript records how many tokens each reply was given, never the size
// of the window they were given into. The CLI does say it — a headless run's
// final result lists every model it used with its `contextWindow` — so every
// structured run Canopy makes (brain calls, compactions) leaves the figure
// here, and the context meter shows "of 1M" only for a model the CLI has
// actually reported. A model never seen this way shows its tokens alone.

const KEY = "canopy.contextWindows";

type Windows = Record<string, { tokens: number; at: number }>;

function read(): Windows {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Windows) : {};
  } catch {
    return {};
  }
}

/** Record what a run reported, by model id. */
export function noteContextWindows(windows: Record<string, number> | undefined): void {
  if (!windows) return;
  const all = read();
  let changed = false;
  for (const [model, tokens] of Object.entries(windows)) {
    if (!model || !Number.isFinite(tokens) || tokens <= 0) continue;
    if (all[model]?.tokens === tokens) continue;
    all[model] = { tokens, at: Date.now() };
    changed = true;
  }
  if (!changed) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the meter just shows tokens */
  }
}

/** The window the CLI reported for `model`, or null when it never has. */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  return read()[model]?.tokens ?? null;
}

/** "44.8k of 1M · 4%", or "44.8k" when the window is unknown. */
export function contextUseText(tokens: number, window: number | null): string {
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
      : n >= 1000
        ? `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
        : String(n);
  if (!window) return fmt(tokens);
  return `${fmt(tokens)} of ${fmt(window)} · ${Math.min(100, Math.round((tokens / window) * 100))}%`;
}

// Presentation rules for subscription plan limits — the "how much of my plan
// is left" side of usage, as opposed to the "what did this cost" side in
// pricing.ts. Kept out of the components so the formatting is testable without
// a DOM: the numbers are the whole point of the feature, and a chip that reads
// 5% when the truth is 95% is worse than no chip.

import type { PlanUsage, PlanWindow } from "./ipc";

/** Beyond this a window is worth warning about; beyond CRITICAL it is nearly
 *  spent. Chosen to fire while there is still room to change plans for the day,
 *  not once the session is already blocked. */
export const WARN_PERCENT = 75;
export const CRITICAL_PERCENT = 90;

export type PlanTone = "normal" | "warn" | "critical";

/** A plan's tone is its worst window's — one exhausted window blocks work even
 *  when the others are empty. */
export function planTone(plan: PlanUsage): PlanTone {
  const worst = Math.max(0, ...plan.windows.map((w) => w.used_percent));
  if (worst >= CRITICAL_PERCENT) return "critical";
  if (worst >= WARN_PERCENT) return "warn";
  return "normal";
}

/** The status-tray chip: every window, most-constrained first so the number
 *  that matters is the one nearest the eye. */
export function chipText(plan: PlanUsage): string {
  return [...plan.windows]
    .sort((a, b) => b.used_percent - a.used_percent)
    .map((w) => `${w.label} ${Math.round(w.used_percent)}%`)
    .join(" · ");
}

/** "resets in 2h49m" / "resetting now". Null when the provider gave no reset
 *  time — some do not, and inventing one would be a lie about when work can
 *  resume. */
export function resetText(w: PlanWindow, now = Date.now()): string | null {
  if (!w.resets_at) return null;
  const secs = w.resets_at - Math.floor(now / 1000);
  if (secs <= 0) return "resetting now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `resets in ${d}d ${h % 24}h`;
  }
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

/** How old a snapshot is, phrased for a tooltip — or null while it is fresh
 *  enough that saying so would be noise.
 *
 *  This exists because of a real gap, not defensiveness: neither Claude nor
 *  Codex reports limits on a request that was *rejected* for hitting them, so
 *  the reading necessarily goes stale exactly when the user is blocked. Showing
 *  the last known value with its age beats showing nothing. */
export function stalenessText(plan: PlanUsage, now = Date.now()): string | null {
  if (!plan.observed) return null;
  const mins = Math.floor((Math.floor(now / 1000) - plan.observed) / 60);
  if (mins < 10) return null;
  if (mins < 60) return `as of ${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `as of ${h}h ago`;
  return `as of ${Math.floor(h / 24)}d ago`;
}

/** Plan names as the providers spell them, tidied for display. Unknown values
 *  pass through rather than being dropped — a name we have not seen is still
 *  more informative than nothing. */
export function planLabel(plan: PlanUsage): string | null {
  const raw = plan.plan;
  if (!raw) return null;
  const known: Record<string, string> = {
    default_claude_max_20x: "Max (20x)",
    default_claude_max_5x: "Max (5x)",
    default_claude_pro: "Pro",
    claude_max_20x: "Max (20x)",
    claude_max_5x: "Max (5x)",
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    premium: "Premium",
  };
  return known[raw] ?? raw.replace(/^default_/, "").replace(/_/g, " ");
}

/** Full tooltip for the chip: plan name, every window with its reset, and the
 *  staleness note when there is one. */
export function tooltip(plan: PlanUsage, now = Date.now()): string {
  const head = planLabel(plan);
  const lines = plan.windows.map((w) => {
    const reset = resetText(w, now);
    return `${w.label}: ${Math.round(w.used_percent)}% used${reset ? ` · ${reset}` : ""}`;
  });
  const stale = stalenessText(plan, now);
  return [head, ...lines, stale].filter(Boolean).join("\n");
}

/** The plan row for the CLI driving the tray, if it reports one.
 *
 *  Matched on the account too, not just the CLI: a machine with two logins
 *  reports one row per subscription, and the tray follows a specific session.
 *  Showing that session the *other* account's headroom would be worse than
 *  showing nothing — it reads as room the user does not have. An unmatched
 *  profile therefore yields null rather than falling back to any row. */
export function planFor(
  plans: PlanUsage[],
  agent: string | null | undefined,
  profile: string = "default",
): PlanUsage | null {
  if (!agent) return null;
  return (
    plans.find(
      (p) => p.agent === agent && (p.profile || "default") === profile,
    ) ?? null
  );
}

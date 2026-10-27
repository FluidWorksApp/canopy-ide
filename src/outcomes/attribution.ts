// Where the money went: agent session spend attributed to plan, task class,
// person and CLI, beside Canopy's own brain spend by feature.
//
// Agent spend comes from the per-session `spend` records (the agent CLI's own
// usage store, so it covers every CLI that reports tokens); Canopy's spend
// comes from the brain meter. They are kept apart on purpose: one is work the
// user asked agents to do, the other is what Canopy's intelligence costs on
// top, and a user deciding whether either is worth it needs to see both.

import type { BrainSpend } from "../brainMeter";
import { latestSpends } from "./metrics";
import { UNPLANNED, type SpendData } from "./types";

export interface SpendSlice {
  key: string;
  label: string;
  sessions: number;
  costUsd: number;
  turns: number;
  tokens: number;
  /** Any member's cost was estimated from tokens rather than CLI-reported. */
  estimated: boolean;
}

export interface Attribution {
  totalUsd: number;
  byPlan: SpendSlice[];
  byClass: SpendSlice[];
  byPerson: SpendSlice[];
  byCli: SpendSlice[];
  /** Canopy's own brain spend, per feature, over the same window. */
  canopy: { feature: string; calls: number; costUsd: number }[];
  canopyUsd: number;
}

function slice(
  spends: SpendData[],
  keyOf: (s: SpendData) => string,
  labelOf: (key: string) => string = (k) => k,
): SpendSlice[] {
  const by = new Map<string, SpendSlice>();
  for (const s of spends) {
    const key = keyOf(s);
    const g = by.get(key) ?? {
      key,
      label: labelOf(key),
      sessions: 0,
      costUsd: 0,
      turns: 0,
      tokens: 0,
      estimated: false,
    };
    g.sessions += 1;
    g.costUsd += s.costUsd;
    g.turns += s.turns;
    g.tokens += s.inputTokens + s.outputTokens;
    if (!s.costReported) g.estimated = true;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export function attributeSpend(
  spends: SpendData[],
  opts: {
    sinceMs: number;
    planTitles?: Map<string, string>;
    cliName?: (id: string) => string;
    brainByFeature?: Record<string, BrainSpend>;
  },
): Attribution {
  const rows = latestSpends(spends).filter((s) => s.lastTs >= opts.sinceMs);
  const canopy = Object.entries(opts.brainByFeature ?? {})
    .map(([feature, s]) => ({ feature, calls: s.calls, costUsd: s.costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return {
    totalUsd: rows.reduce((n, s) => n + s.costUsd, 0),
    byPlan: slice(
      rows,
      (s) => s.planId ?? UNPLANNED,
      (k) => (k === UNPLANNED ? "No plan" : (opts.planTitles?.get(k) ?? `Plan ${k.slice(-6)}`)),
    ),
    byClass: slice(rows, (s) => s.taskClass ?? UNPLANNED),
    byPerson: slice(rows, (s) => s.person),
    byCli: slice(rows, (s) => s.cli, opts.cliName),
    canopy,
    canopyUsd: canopy.reduce((n, c) => n + c.costUsd, 0),
  };
}

// What the linked CLI may add to work items, and the rules that keep it
// advisory. Deterministic edges outrank the model: a hint can name a group,
// and it can home a tab the edge pass left loose, but it can never move a tab
// an edge already placed, merge groups, or invent one. Pure — the transport
// that produced the reply lives in workItemBrain.ts.

import type { WorkItem } from "./workItems";

export interface HintAssign {
  tabId: string;
  key: string;
  confidence: number;
}

export interface WorkItemHints {
  /** Human names per work-item key. */
  labels: Record<string, string>;
  /** Suggested homes for loose tabs. */
  assign: HintAssign[];
}

export const EMPTY_HINTS: WorkItemHints = { labels: {}, assign: [] };

const LABEL_MAX = 48;

/** Below this, a suggestion is noise and never applied. */
export const HINT_MIN_CONFIDENCE = 0.8;

/**
 * The reply contract, parsed tolerantly: the first `{` to the last `}`, so a
 * model that wraps its JSON in prose or a fence still lands. Anything
 * malformed inside is dropped field-by-field; a reply with nothing usable is
 * null so the caller keeps the hints it had.
 */
export function parseHintsReply(text: string): WorkItemHints | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const labels: Record<string, string> = {};
  if (typeof obj.labels === "object" && obj.labels !== null) {
    for (const [key, value] of Object.entries(obj.labels)) {
      if (typeof value !== "string") continue;
      const label = value.trim().slice(0, LABEL_MAX);
      if (label) labels[key] = label;
    }
  }

  const assign: HintAssign[] = [];
  if (Array.isArray(obj.assign)) {
    for (const entry of obj.assign) {
      if (typeof entry !== "object" || entry === null) continue;
      const { tabId, key, confidence } = entry as Record<string, unknown>;
      if (typeof tabId !== "string" || typeof key !== "string") continue;
      if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) continue;
      assign.push({ tabId, key, confidence });
    }
  }

  if (!Object.keys(labels).length && !assign.length) return null;
  return { labels, assign };
}

/**
 * Fold assignment hints into the deterministic grouping. A tab moves only
 * when every gate passes: the hint clears the confidence bar, the tab's
 * current group is its own singleton (the edge pass left it loose), the
 * caller's `movable` allows it (sessions and workspaces never move — they
 * found groups), and the target group exists. Labels are the caller's to read
 * from the hints directly; this touches membership only.
 */
export function applyHints(
  groups: readonly WorkItem[],
  hints: WorkItemHints,
  movable: (tabId: string) => boolean = () => true,
  minConfidence: number = HINT_MIN_CONFIDENCE,
): WorkItem[] {
  const out = groups.map((g) => ({ key: g.key, ids: [...g.ids] }));
  const byKey = new Map(out.map((g) => [g.key, g]));
  for (const hint of hints.assign) {
    if (hint.confidence < minConfidence) continue;
    if (!movable(hint.tabId)) continue;
    const from = byKey.get(hint.tabId);
    if (!from || from.ids.length !== 1 || from.ids[0] !== hint.tabId) continue;
    const to = byKey.get(hint.key);
    if (!to || to === from) continue;
    to.ids.push(hint.tabId);
    byKey.delete(hint.tabId);
  }
  return [...byKey.values()];
}

/**
 * The compact, stable description of the current grouping that a refresh
 * sends. Stable so it doubles as the change key: two identical digests mean
 * nothing worth re-asking about.
 */
export function buildWorkItemDigest(
  groups: readonly WorkItem[],
  describe: (id: string) => string,
): string {
  return groups
    .map((g) => [`item ${g.key}`, ...g.ids.map((id) => `  ${id}: ${describe(id)}`)].join("\n"))
    .join("\n");
}

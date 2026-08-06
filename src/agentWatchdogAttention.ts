import { activeView, type ActiveView } from "./activeView";
import {
  attentionItems,
  isOutstanding,
  postAttention,
  resolveAttentionByKey,
  type AttentionItem,
} from "./attention";
import { judgeAgents, type AgentIncident, type AgentSample } from "./agentWatchdog";
import type { AgentLifeView } from "./agentLifeStore";

export interface AgentWatchdogTarget {
  tabId: string;
  label: string;
  path: string;
}

export interface AgentWatchdogTick {
  views: readonly AgentLifeView[];
  targets: ReadonlyMap<number, AgentWatchdogTarget>;
  projectId: string;
  projectName: string;
  at?: number;
}

// Durable incident persistence plugs in here when Store::Tasks lands; MVP keeps process-lifetime dedupe.
const announcedIncidents = new Set<string>();
const openQuietIncidents = new Map<string, Set<string>>();
let staleQuietCleaned = false;

export function samplesForAgentViews(
  views: readonly AgentLifeView[],
  targets: ReadonlyMap<number, AgentWatchdogTarget>,
  current: ActiveView,
  projectId: string,
  at: number,
): AgentSample[] {
  return views.map((view) => {
    const target = targets.get(view.ptyId);
    return {
      at,
      ptyId: view.ptyId,
      sessionId: view.sessionId,
      state: view.life.state,
      reason: view.life.reason ?? null,
      stateSince: view.life.since * 1000,
      blockedSince:
        view.attention.kind === "blocked" ? view.attention.since : null,
      seen:
        current.projectId === projectId &&
        current.kind === "terminal" &&
        current.tabId === target?.tabId,
    };
  });
}

function minutesSince(incident: AgentIncident): number {
  return Math.max(1, Math.floor((incident.at - incident.since) / 60_000));
}

function blockedItemFor(sessionId: string | null): AttentionItem | undefined {
  if (!sessionId) return undefined;
  const key = `agent:${sessionId}`;
  return attentionItems().find(
    (item) => item.dedupeKey === key && isOutstanding(item),
  );
}

function bumpBlockedItem(sessionId: string | null): boolean {
  const existing = blockedItemFor(sessionId);
  if (!existing) return false;
  if (existing.tone === "error") return true;
  postAttention({
    kind: "question",
    tone: "error",
    title: existing.title,
    body: existing.body,
    source: existing.source,
    projectId: existing.projectId,
    projectName: existing.projectName,
    where: existing.where,
    dedupeKey: existing.dedupeKey,
  });
  return true;
}

function cleanStaleQuietAttention(): void {
  if (staleQuietCleaned) return;
  staleQuietCleaned = true;
  for (const item of attentionItems()) {
    if (item.dedupeKey?.startsWith("W1:") && isOutstanding(item))
      resolveAttentionByKey(item.dedupeKey, "withdrawn");
  }
}

export function tickAgentWatchdogAttention(tick: AgentWatchdogTick): void {
  cleanStaleQuietAttention();
  const at = tick.at ?? Date.now();
  const samples = samplesForAgentViews(
    tick.views,
    tick.targets,
    activeView(),
    tick.projectId,
    at,
  );
  const views = new Map(tick.views.map((view) => [view.ptyId, view]));
  const incidents = judgeAgents(samples);
  const quietNow = new Set(
    incidents.filter((incident) => incident.code === "W1").map((incident) => incident.key),
  );
  for (const key of openQuietIncidents.get(tick.projectId) ?? []) {
    if (!quietNow.has(key)) resolveAttentionByKey(key, "withdrawn");
  }
  openQuietIncidents.set(tick.projectId, quietNow);

  for (const incident of incidents) {
    if (announcedIncidents.has(incident.key)) {
      if (incident.code === "W2") bumpBlockedItem(incident.sessionId);
      continue;
    }
    const view = views.get(incident.ptyId);
    const target = tick.targets.get(incident.ptyId);
    const label = target?.label || view?.life.agent || `terminal ${incident.ptyId}`;
    const where = {
      kind: "terminal" as const,
      ptyId: incident.ptyId,
      ...(target?.path ? { path: target.path } : {}),
    };

    if (incident.code === "W1") {
      postAttention({
        kind: "question",
        tone: "warn",
        title: `${label} went quiet ${minutesSince(incident)} min ago — look?`,
        body: "Canopy has not taken any automatic action.",
        source: "agent",
        projectId: tick.projectId,
        projectName: tick.projectName,
        where,
        dedupeKey: incident.key,
      });
    } else {
      if (!bumpBlockedItem(incident.sessionId)) continue;
    }

    announcedIncidents.add(incident.key);
  }
}

export function clearAgentWatchdogAttention(projectId: string): void {
  for (const key of openQuietIncidents.get(projectId) ?? [])
    resolveAttentionByKey(key, "withdrawn");
  openQuietIncidents.delete(projectId);
}

export function resetAgentWatchdogAttentionForTest(): void {
  announcedIncidents.clear();
  openQuietIncidents.clear();
  staleQuietCleaned = false;
}

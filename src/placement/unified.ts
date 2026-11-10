// One list for everything Canopy can see: local projects and agents, remote
// workspaces' projects and agents, T3 Code projects and threads, and mesh
// jobs sent to cloud workspaces. Pure: the caller gathers the inputs.
import { targetKey, type Target } from "./types";

export type UnifiedKind = "project" | "agent" | "thread" | "job" | "session";

export interface UnifiedRow {
  id: string;
  name: string;
  kind: UnifiedKind;
  target: Target;
  /** Human label of the target, for the badge. */
  targetLabel: string;
  status: string;
  branch?: string;
  /** Stable project identity for project rows. */
  projectId?: string;
  /** A remote placeholder for a local project that is not on that remote yet. */
  needsSetup: boolean;
}

export interface UnifiedGroup {
  /** Lowercased project name used to group the same project across targets. */
  key: string;
  name: string;
  rows: UnifiedRow[];
}

interface Item {
  id: string;
  name: string;
  status?: string;
  branch?: string;
  /** Project the item belongs to, by name. */
  project?: string;
}

export interface UnifiedInput {
  local: { projects: { id: string; name: string }[]; agents: Item[] };
  /** `projects`/`agents` are absent when that workspace is not the active
   *  host: its contents cannot be read without switching to it. */
  remotes: {
    workspaceId: string;
    name: string;
    state: string;
    projects?: { id: string; name: string }[];
    agents?: Item[];
    /** Running sessions read from outside, when that workspace is not the active
     *  host. Agents and shells together: the list cannot tell them apart. */
    sessions?: { id: string; title: string }[];
  }[];
  t3: { machineId: string; label: string; projects: { id: string; title: string }[]; threads: Item[] }[];
  jobs: { jobId: string; title: string; workspace: string; target: string; workspaceId?: string }[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildUnifiedRows(input: UnifiedInput): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  const local: Target = { kind: "local" };
  const push = (r: Omit<UnifiedRow, "needsSetup"> & { needsSetup?: boolean }) =>
    rows.push({ needsSetup: false, ...r });

  for (const p of input.local.projects)
    push({ id: `local:project:${p.id}`, projectId: p.id, name: p.name, kind: "project", target: local, targetLabel: "This Mac", status: "ready" });
  for (const a of input.local.agents)
    push({ id: `local:agent:${a.id}`, name: a.project ?? a.name, kind: "agent", target: local, targetLabel: "This Mac", status: a.status ?? "running", branch: a.branch });

  for (const w of input.remotes) {
    const target: Target = { kind: "remote", workspaceId: w.workspaceId };
    const online = w.state === "ready";
    if (w.projects) {
      const have = new Set(w.projects.map((p) => p.id));
      for (const p of w.projects)
        push({ id: `${targetKey(target)}:project:${p.id}`, projectId: p.id, name: p.name, kind: "project", target, targetLabel: w.name, status: online ? "ready" : w.state });
      if (online)
        for (const p of input.local.projects)
          if (!have.has(p.id))
            push({ id: `${targetKey(target)}:setup:${p.id}`, projectId: p.id, name: p.name, kind: "project", target, targetLabel: w.name, status: "not set up", needsSetup: true });
    }
    for (const x of w.sessions ?? [])
      push({ id: `${targetKey(target)}:session:${x.id}`, name: x.title, kind: "session", target, targetLabel: w.name, status: "running" });
    for (const a of w.agents ?? [])
      push({ id: `${targetKey(target)}:agent:${a.id}`, name: a.project ?? a.name, kind: "agent", target, targetLabel: w.name, status: a.status ?? "running", branch: a.branch });
  }

  for (const m of input.t3) {
    const target: Target = { kind: "t3", machineId: m.machineId };
    for (const p of m.projects)
      push({ id: `${targetKey(target)}:project:${p.id}`, projectId: p.id, name: p.title, kind: "project", target, targetLabel: m.label, status: "ready" });
    const byId = new Map(m.projects.map((p) => [p.id, p.title]));
    for (const t of m.threads)
      push({ id: `${targetKey(target)}:thread:${t.id}`, name: (t.project && byId.get(t.project)) ?? t.project ?? "T3 Code", kind: "thread", target, targetLabel: m.label, status: t.status ?? "idle", branch: t.branch });
  }

  for (const j of input.jobs) {
    const target: Target = j.workspaceId ? { kind: "remote", workspaceId: j.workspaceId } : local;
    push({ id: `job:${j.jobId}`, name: j.title, kind: "job", target, targetLabel: j.workspace, status: "sent" });
  }
  return rows;
}

/** Group by project name so one project shows its local and remote copies together. */
export function groupByProject(rows: UnifiedRow[]): UnifiedGroup[] {
  const groups = new Map<string, UnifiedGroup>();
  for (const r of rows) {
    const key = norm(r.name);
    const g = groups.get(key) ?? { key, name: r.name, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface UnifiedFilter {
  /** "all" or a stable targetKey such as remote:workspace-id. */
  target?: string;
  kind?: UnifiedKind | "all";
  text?: string;
}

export function filterRows(rows: UnifiedRow[], f: UnifiedFilter): UnifiedRow[] {
  const text = norm(f.text ?? "");
  return rows.filter(
    (r) =>
      (!f.target || f.target === "all" || targetKey(r.target) === f.target) &&
      (!f.kind || f.kind === "all" || r.kind === f.kind) &&
      (!text || norm(r.name).includes(text) || norm(r.targetLabel).includes(text)),
  );
}

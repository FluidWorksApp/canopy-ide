// Persisted placement preferences: a global default, one per project and one
// per agent kind. Stored flat in localStorage like src/settings.ts.
import {
  automaticPreference,
  inheritPreference,
  targetPreference,
  type Preference,
  type Target,
} from "./types";

const KEY = "canopy:placement:v1";

type Level = "global" | "override";
interface Stored {
  global: Preference;
  projects: Record<string, Preference>;
  agents: Record<string, Preference>;
}

function target(raw: unknown): Target | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "local") return { kind: "local" };
  if (value.kind === "remote" && typeof value.workspaceId === "string" && value.workspaceId)
    return { kind: "remote", workspaceId: value.workspaceId };
  if (value.kind === "t3" && typeof value.machineId === "string" && value.machineId)
    return { kind: "t3", machineId: value.machineId };
  return null;
}

export function parsePreference(raw: unknown, level: Level): Preference {
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    if (value.mode === "automatic") return automaticPreference();
    if (value.mode === "inherit") return level === "global" ? automaticPreference() : inheritPreference();
    if (value.mode === "target") {
      const parsed = target(value.target);
      if (parsed) return targetPreference(parsed);
    }
  }

  // canopy:placement:v1 originally stored broad strings. Keep them readable
  // without pretending a generic remote choice identifies a real machine.
  if (raw === "local") return targetPreference({ kind: "local" });
  if (raw === "balance") return automaticPreference();
  if (raw === "auto") return level === "global" ? automaticPreference() : inheritPreference();
  if (raw === "remote") return level === "global" ? automaticPreference() : inheritPreference();
  return level === "global" ? automaticPreference() : inheritPreference();
}

export const isPreference = (value: unknown): value is Preference => {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return p.mode === "inherit" || p.mode === "automatic" || (p.mode === "target" && target(p.target) !== null);
};

function clean(raw: unknown): Record<string, Preference> {
  const out: Record<string, Preference> = Object.create(null);
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      const parsed = parsePreference(value, "override");
      if (parsed.mode !== "inherit") out[key] = parsed;
    }
  }
  return out;
}

function load(): Stored {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return {
      global: parsePreference(parsed?.global, "global"),
      projects: clean(parsed?.projects),
      agents: clean(parsed?.agents),
    };
  } catch {
    return { global: automaticPreference(), projects: clean(null), agents: clean(null) };
  }
}

function save(stored: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* Storage is optional. */
  }
}

export const getGlobalPreference = (): Preference => load().global;
export const getProjectPreference = (id: string): Preference => load().projects[id] ?? inheritPreference();
export const getAgentPreference = (kind: string): Preference => load().agents[kind] ?? inheritPreference();

export function setGlobalPreference(preference: Preference) {
  save({ ...load(), global: preference.mode === "inherit" ? automaticPreference() : preference });
}

function setIn(table: "projects" | "agents", id: string, preference: Preference) {
  const stored = load();
  const next = { ...stored[table] };
  if (preference.mode === "inherit") delete next[id];
  else next[id] = preference;
  save({ ...stored, [table]: next });
}

export const setProjectPreference = (id: string, preference: Preference) => setIn("projects", id, preference);
export const setAgentPreference = (kind: string, preference: Preference) => setIn("agents", kind, preference);

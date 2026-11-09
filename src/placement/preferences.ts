// Persisted placement preferences: a global default, one per project and one
// per agent kind. Stored flat in localStorage like src/settings.ts.
import type { Preference } from "./types";

const KEY = "canopy:placement:v1";
const VALID: readonly Preference[] = ["local", "remote", "balance", "auto"];

interface Stored {
  global: Preference;
  projects: Record<string, Preference>;
  agents: Record<string, Preference>;
}

export const isPreference = (v: unknown): v is Preference => VALID.includes(v as Preference);

function clean(raw: unknown): Record<string, Preference> {
  const out: Record<string, Preference> = Object.create(null);
  if (raw && typeof raw === "object")
    for (const [k, v] of Object.entries(raw)) if (isPreference(v) && v !== "auto") out[k] = v;
  return out;
}

function load(): Stored {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return { global: isPreference(p?.global) ? p.global : "auto", projects: clean(p?.projects), agents: clean(p?.agents) };
  } catch {
    return { global: "auto", projects: clean(null), agents: clean(null) };
  }
}

function save(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* Storage is optional. */
  }
}

export const getGlobalPreference = (): Preference => load().global;
export const getProjectPreference = (id: string): Preference => load().projects[id] ?? "auto";
export const getAgentPreference = (kind: string): Preference => load().agents[kind] ?? "auto";

export function setGlobalPreference(p: Preference) {
  save({ ...load(), global: p });
}

// Setting "auto" clears the entry: auto is the absence of an override.
function setIn(table: "projects" | "agents", id: string, p: Preference) {
  const s = load();
  const next = { ...s[table] };
  if (p === "auto") delete next[id];
  else next[id] = p;
  save({ ...s, [table]: next });
}

export const setProjectPreference = (id: string, p: Preference) => setIn("projects", id, p);
export const setAgentPreference = (kind: string, p: Preference) => setIn("agents", kind, p);

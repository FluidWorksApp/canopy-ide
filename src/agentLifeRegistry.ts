// Every agent terminal's current state, across the open projects. Each
// ProjectView works out its own agents' states (shared/agentLife) and
// publishes them here, so window-wide code (the Teams agent inbox) can ask
// whether an agent is mid-turn without reaching into a project.
import type { LifeState } from "../shared/agentLife";

export type AgentLifeEntry = { state: LifeState; quietMs: number | null };

const byProject = new Map<string, Map<number, AgentLifeEntry>>();
const listeners = new Set<() => void>();

/** Replace one project's agents. An empty map (or unmount) removes them. */
export function publishAgentLives(project: string, lives: Map<number, AgentLifeEntry>): void {
  if (lives.size) byProject.set(project, lives);
  else byProject.delete(project);
  listeners.forEach((fn) => fn());
}

export function agentLife(ptyId: number): AgentLifeEntry | undefined {
  for (const lives of byProject.values()) {
    const entry = lives.get(ptyId);
    if (entry) return entry;
  }
  return undefined;
}

export function subscribeAgentLives(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

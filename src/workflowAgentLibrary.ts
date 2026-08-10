import * as ipc from "./ipc";
import { redactSecrets } from "./vibeSecretScan";
import type { WorkflowAgentBlock } from "./workflowDefinition";

export interface WorkflowAgentLibraryLoad {
  agents: WorkflowAgentBlock[];
  errors: string[];
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const parseAgent = (value: unknown): WorkflowAgentBlock | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const agent = value as Record<string, unknown>;
  const allowed = new Set(["id", "name", "type", "config", "prompt"]);
  if (Object.keys(agent).some((key) => !allowed.has(key))) return null;
  if (typeof agent.id !== "string" || !ID.test(agent.id)) return null;
  if (typeof agent.name !== "string" || !agent.name.trim() || agent.name.length > 128) return null;
  if (typeof agent.type !== "string" || !agent.type.trim() || agent.type.length > 128) return null;
  if (agent.config !== undefined) {
    if (!agent.config || typeof agent.config !== "object" || Array.isArray(agent.config)) return null;
    const entries = Object.entries(agent.config as Record<string, unknown>);
    if (entries.length > 32 || entries.some(([key, item]) =>
      !ID.test(key) || typeof item !== "string" || !item.trim() || item.length > 512)) return null;
  }
  if (agent.prompt !== undefined && (typeof agent.prompt !== "string" || agent.prompt.length > 32_000)) return null;
  return agent as unknown as WorkflowAgentBlock;
};

export async function loadWorkflowAgentLibrary(projectRoot: string): Promise<WorkflowAgentLibraryLoad> {
  const dir = `${projectRoot.replace(/[\\/]+$/, "")}/.canopy/agents`;
  let entries: ipc.DirEntry[];
  try {
    entries = await ipc.fsReadDir(dir);
  } catch (error) {
    return /not found|no such file/i.test(String(error))
      ? { agents: [], errors: [] }
      : { agents: [], errors: [`Could not read reusable agents: ${String(error)}`] };
  }
  const agents: WorkflowAgentBlock[] = [];
  const errors: string[] = [];
  for (const entry of entries.filter((item) => !item.is_dir && item.name.endsWith(".json"))) {
    try {
      const source = await ipc.fsReadText(entry.path, 128 * 1024);
      if (redactSecrets(source) !== source) { errors.push(`${entry.name}: contains a credential value`); continue; }
      const agent = parseAgent(JSON.parse(source));
      if (!agent) { errors.push(`${entry.name}: invalid reusable agent block`); continue; }
      agents.push(agent);
    } catch (error) {
      errors.push(`${entry.name}: ${String(error)}`);
    }
  }
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) errors.push(`Reusable agent library duplicates ${agent.id}`);
    ids.add(agent.id);
  }
  return { agents: errors.length > 0 ? [] : agents, errors };
}

import type { ModelChoice } from "./agentModels";
import { SEEDS } from "./modelCatalog";
import {
  agentCliFor,
  type AgentCli,
  type AgentConfigField,
  type AgentLaunchOptions,
} from "./projects";
import type { WorkflowAgentBlock, WorkflowAgentStep } from "./workflowDefinition";

export type AgentLaunchSelection = AgentLaunchOptions;

export const workflowAgentType = (typeId: string): AgentCli | undefined =>
  agentCliFor(typeId);

/** Resolve a manifest's catalogue declaration without knowing the agent id. */
export const modelChoicesFor = (field?: AgentConfigField): ModelChoice[] => {
  if (field?.control !== "model" || !field.modelFamilies) return [];
  return field.modelFamilies.flatMap((family) => SEEDS[family]);
};

export const workflowAgentForStep = (
  definition: { agents?: WorkflowAgentBlock[] },
  step: WorkflowAgentStep,
): WorkflowAgentBlock | undefined =>
  step.agent ? definition.agents?.find((agent) => agent.id === step.agent) : undefined;

export const workflowAgentPrompt = (
  block: WorkflowAgentBlock | undefined,
  step: WorkflowAgentStep,
): string => [block?.prompt?.trim(), step.prompt.trim()].filter(Boolean).join("\n\n");

/** Return a detached copy so a run cannot mutate the reusable block snapshot. */
export const workflowAgentSelection = (
  block: WorkflowAgentBlock | undefined,
): AgentLaunchSelection => ({ ...(block?.config ?? {}) });

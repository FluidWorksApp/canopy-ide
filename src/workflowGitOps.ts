import * as ipc from "./ipc";
import { runAbstractionPlan } from "./vibeAbstractionRunner";
import type { WorkflowGitOpStep } from "./workflowDefinition";

export interface WorkflowGitDeps {
  run(argv: string[], cwd: string): Promise<{ ok: boolean; output: string }>;
  updateBranch(repo: string, number: number): Promise<unknown>;
}
const nativeDeps: WorkflowGitDeps = {
  run: (argv, cwd) => runAbstractionPlan(argv, cwd, {
    ptySpawnDetached: ipc.ptySpawnArgv,
    onPtyExit: (listen) => ipc.onPtyExit((event) => listen({ id: event.id, exit_code: event.exit_code ?? null })),
    ptyOutput: ipc.ptyOutput, ptyKill: ipc.ptyKill,
  }),
  updateBranch: ipc.ghPrUpdateBranch,
};

/** Explicit targets come from the pinned workflow, never ambient selection. */
export async function executeWorkflowGitOp(step: WorkflowGitOpStep, cwd: string, deps = nativeDeps): Promise<{ ok: boolean }> {
  const p = step.parameters;
  if (!p || !/^[\w.-]+\/[\w.-]+$/.test(p.repo)) throw new Error("Set this workflow step's repository and pull-request parameters first.");
  if (!["network", "git-write", step.operation].every((grant) => step.capabilities.includes(grant as typeof step.capabilities[number]))) throw new Error("The workflow does not grant this git operation.");
  if (step.operation === "update-branch") {
    if (!Number.isSafeInteger(p.number) || p.number! < 1) throw new Error("Select the pull request to update.");
    await deps.updateBranch(p.repo, p.number!);
    return { ok: true };
  }
  if (![p.head, p.base, p.title, p.body].every((value) => typeof value === "string" && value.trim()) || [p.head!, p.base!].some((branch) => branch.startsWith("-") || ( /\s/.test(branch) || [...branch].some((character) => character.charCodeAt(0) < 32) ))) throw new Error("Opening a PR requires its head, base, title, and description.");
  // Reconcile a prior successful create before retrying after interruption.
  const existing = await deps.run(["gh", "pr", "list", "--repo", p.repo, "--head", p.head!, "--base", p.base!, "--state", "open", "--json", "number"], cwd);
  if (!existing.ok) return { ok: false };
  const rows: unknown = JSON.parse(existing.output);
  if (!Array.isArray(rows)) throw new Error("Could not reconcile the pull request.");
  if (rows.length) return { ok: true };
  return deps.run(["gh", "pr", "create", "--draft", "--repo", p.repo, "--head", p.head!, "--base", p.base!, "--title", p.title!, "--body", p.body!], cwd);
}

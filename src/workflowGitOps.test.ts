import { expect, it, vi } from "vitest";
import { executeWorkflowGitOp } from "./workflowGitOps";
import type { WorkflowGitOpStep } from "./workflowDefinition";
const step: WorkflowGitOpStep = { id: "pr", name: "PR", kind: "git-op", operation: "open-pr", capabilities: ["network", "git-write", "open-pr"], parameters: { repo: "owner/repo", head: "feat/app", base: "main", title: "App", body: "The app changes." } };
it("reconciles an existing PR without creating a duplicate", async () => {
  const run = vi.fn(async () => ({ ok: true, output: '[{"number":42}]' }));
  expect(await executeWorkflowGitOp(step, "/app", { run, updateBranch: vi.fn() })).toEqual({ ok: true });
  expect(run).toHaveBeenCalledTimes(1);
});
it("creates a draft using pinned structured parameters", async () => {
  const run = vi.fn(async () => ({ ok: true, output: "[]" }));
  await executeWorkflowGitOp(step, "/app", { run, updateBranch: vi.fn() });
  expect(run).toHaveBeenLastCalledWith(["gh", "pr", "create", "--draft", "--repo", "owner/repo", "--head", "feat/app", "--base", "main", "--title", "App", "--body", "The app changes."], "/app");
});
it("cannot infer a repository from the active UI", async () => {
  const run = vi.fn();
  await expect(executeWorkflowGitOp({ ...step, parameters: undefined }, "/app", { run, updateBranch: vi.fn() })).rejects.toThrow(/parameters/);
  expect(run).not.toHaveBeenCalled();
});

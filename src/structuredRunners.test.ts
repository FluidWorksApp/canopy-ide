import { describe, expect, it } from "vitest";
import {
  STRUCTURED_RUNNERS,
  type StructuredRunnerAuthority,
  type StructuredRunnerLaunch,
} from "./structuredRunners";

const launch = (
  authority: StructuredRunnerAuthority,
): StructuredRunnerLaunch => ({
  bin: "codex",
  policy: {
    systemPromptAppend: "Work only in this project.",
    permissionMode: "acceptEdits",
    allowedTools: ["mcp__canopy"],
    disallowedTools: ["KillShell", "NotebookEdit"],
    model: "gpt-5.6-sol",
    sessionId: "thread-1",
    cwd: "/repo/app",
    authority,
    network: true,
    writableRoots: ["/repo/app", "/repo/shared"],
  },
  additionalDirectories: ["/repo/shared"],
});

const workspaceConfig = (args: readonly string[]) =>
  args.filter((arg) => arg.startsWith("sandbox_workspace_write."));

describe("structured runner sandbox policy", () => {
  it("carries network and writable roots into a workspace-write launch", () => {
    const args = STRUCTURED_RUNNERS.codex.args(launch("workspace-write"));

    expect(args).toEqual(expect.arrayContaining(["-s", "workspace-write"]));
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args).toContain(
      'sandbox_workspace_write.writable_roots=["/repo/app","/repo/shared"]',
    );
  });

  it("never describes workspace-write settings on a read-only launch", () => {
    const args = STRUCTURED_RUNNERS.codex.args(launch("read-only"));

    expect(args).toEqual(expect.arrayContaining(["-s", "read-only"]));
    expect(workspaceConfig(args)).toEqual([]);
  });

  it("resumes with the same network and writable roots without the rejected -s flag", () => {
    const spec = launch("workspace-write");
    const first = STRUCTURED_RUNNERS.codex.args(spec);
    const resumed = STRUCTURED_RUNNERS.codex.resumeArgs(spec);

    expect(resumed).not.toContain("-s");
    expect(resumed).toContain('sandbox_mode="workspace-write"');
    expect(workspaceConfig(resumed)).toEqual(workspaceConfig(first));
  });

  it("never appends either dialect's unrestricted bypass flag", () => {
    const codex = STRUCTURED_RUNNERS.codex.args(launch("workspace-write"));
    const claude = STRUCTURED_RUNNERS.claude.args({
      ...launch("workspace-write"),
      bin: "claude",
    });

    expect(codex).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(claude).not.toContain("--dangerously-skip-permissions");
  });
});

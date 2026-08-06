import { describe, expect, it } from "vitest";
import {
  createProjectRunner,
  type ProjectRunnerOutput,
  type ProjectRunnerProcess,
} from "./projectRunner";
import {
  STRUCTURED_RUNNERS,
  type StructuredRunnerLaunch,
} from "./structuredRunners";
import type { StructuredRunnerEvent } from "./structuredEvents";

function launch(
  authority: "read-only" | "workspace-write" = "workspace-write",
): StructuredRunnerLaunch {
  return {
    bin: "claude",
    policy: {
      systemPromptAppend: "Build only in this project.",
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash", "KillShell"],
      model: "sonnet",
      sessionId: "session-1",
      cwd: "/repo/app",
      authority,
    },
    env: [["CANOPY_ATTEMPT_ID", "attempt-1"]],
  };
}

function processHarness() {
  const spawned: { attemptId: string; opts: { cwd?: string; args: string[] } }[] = [];
  const writes: { attemptId: string; line: string }[] = [];
  const kills: string[] = [];
  let onData: ((out: ProjectRunnerOutput) => void) | null = null;
  const process: ProjectRunnerProcess = {
    spawn: async (attemptId, opts, next) => {
      spawned.push({ attemptId, opts });
      onData = next;
    },
    write: async (attemptId, line) => void writes.push({ attemptId, line }),
    kill: async (attemptId) => void kills.push(attemptId),
  };
  return { process, spawned, writes, kills, emit: (out: ProjectRunnerOutput) => onData?.(out) };
}

describe("the project runner controller", () => {
  it("keys spawn, write and kill to the same attempt", async () => {
    const io = processHarness();
    const events: StructuredRunnerEvent[] = [];
    const transport = await createProjectRunner(io.process).start(
      "attempt-1",
      "claude",
      launch(),
      { emit: (event) => void events.push(event) },
      { resume: false },
    );

    expect(io.spawned[0].attemptId).toBe("attempt-1");
    expect(io.spawned[0].opts.cwd).toBe("/repo/app");
    expect(io.spawned[0].opts.args).toContain("sonnet");

    await transport.send("make the button blue");
    await transport.stop();
    expect(io.writes[0].attemptId).toBe("attempt-1");
    expect(JSON.parse(io.writes[0].line)).toMatchObject({ type: "user" });
    expect(io.kills).toEqual(["attempt-1"]);

    io.emit({ kind: "line", text: JSON.stringify({ type: "system", subtype: "init" }) });
    expect(events).toContainEqual({ kind: "ready" });
  });

  it("rejects an unkeyed launch", async () => {
    const io = processHarness();
    await expect(
      createProjectRunner(io.process).start(
        "",
        "claude",
        launch(),
        { emit: () => {} },
        { resume: false },
      ),
    ).rejects.toThrow("attempt id");
    expect(io.spawned).toEqual([]);
  });

  it("can describe a write-authorized Claude route without unrestricted shell", () => {
    const spec = launch("workspace-write");
    const args = STRUCTURED_RUNNERS.claude.args(spec);
    expect(spec.policy.authority).toBe("workspace-write");
    expect(args).not.toContain("Edit");
    expect(args).not.toContain("Write");
    expect(args).toContain("Bash");
    expect(args).toContain("KillShell");
  });
});

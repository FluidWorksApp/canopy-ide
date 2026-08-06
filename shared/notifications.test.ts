import { describe, expect, it } from "vitest";
import { derivePending, parseAgentEvent, type AgentEventEntry } from "./notifications";

const entry = (payload: Record<string, unknown>): AgentEventEntry => ({
  ts: 1,
  data: parseAgentEvent(JSON.stringify(payload)),
});

describe("cross-connector event projection", () => {
  it("keeps the durable task binding stamped by the PTY", () => {
    const projected = entry({
      session_id: "claude-1",
      cwd: "/repo",
      canopy_pty: 7,
      canopy_run_id: "run_reserved",
      canopy_attempt_id: "attempt_reserved",
      hook_event_name: "PermissionRequest",
    });
    expect(projected.data).toMatchObject({
      runId: "run_reserved",
      attemptId: "attempt_reserved",
    });
    expect(derivePending([projected])[0]).toMatchObject({
      runId: "run_reserved",
      attemptId: "attempt_reserved",
    });
  });

  it("reads the native Codex stop message field", () => {
    const data = entry({
      session_id: "thr-1",
      cwd: "/repo",
      hook_event_name: "Stop",
      agent: "codex",
      last_assistant_message: "Native hook result",
    }).data;
    expect(data?.lastAssistantMessage).toBe("Native hook result");
  });

  it("does not fabricate a block from an unmapped Antigravity notification", () => {
    const pending = derivePending([
      entry({
        session_id: "agy-1",
        cwd: "/repo",
        hook_event_name: "Notification",
        agent: "agy",
        message: "informational notice",
      }),
    ]);
    expect(pending).toEqual([]);
  });

  it("keeps explicit permission signals authoritative", () => {
    const pending = derivePending([
      entry({
        session_id: "agy-1",
        cwd: "/repo",
        hook_event_name: "Notification",
        agent: "agy",
        canopy_signal: "needs-human-permission",
      }),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("notification");
  });

  it("ignores typed informational Claude notifications", () => {
    const pending = derivePending([
      entry({
        session_id: "claude-1",
        cwd: "/repo",
        hook_event_name: "Notification",
        notification_type: "auth_success",
        message: "Signed in",
      }),
    ]);
    expect(pending).toEqual([]);
  });
});

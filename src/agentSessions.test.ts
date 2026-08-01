// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type * as ipcTypes from "./ipc";
import { useAgentSessions } from "./agentSessions";

vi.mock("./ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve([]),
  contextClaims: () => Promise.resolve([]),
  onAgentClaims: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  sessionForget: () => Promise.resolve(),
}));

const session = (over: Partial<ipcTypes.SessionStats> = {}): ipcTypes.SessionStats => ({
  id: 7,
  title: "claude",
  cwd: "/repo",
  total_cpu: 1,
  total_mem_bytes: 1000,
  quiet_ms: null,
  since_input_ms: null,
  output_bytes: 0,
  procs: [],
  ports: [],
  agent_hint: { bin: "claude", pkg: null, path: null, interactive: true },
  ...over,
});

describe("useAgentSessions.lifeOf", () => {
  it("passes firstSeen, so a terminal we just noticed is starting — not unknown", () => {
    // The exact gap this closes: the panel and the page assembled pty evidence
    // by hand without firstSeen, which made the `startup` rung unreachable
    // there — a booting CLI with no digest yet read as "no signal" instead of
    // "starting up", on the two surfaces most likely to be open while one boots.
    // Quiet in output and CPU (so no working rung answers first), no digest
    // yet: exactly what a CLI looks like in its first seconds.
    const stats = [session({ quiet_ms: 60_000, total_cpu: 0 })];
    const { result } = renderHook(() =>
      useAgentSessions({ visible: false, roots: ["/repo"], stats, liveSessionIds: [] }),
    );
    const row = result.current.sessions[0];
    expect(row).toBeDefined();
    const life = result.current.lifeOf(row);
    expect(life.state).toBe("starting");
    expect(life.via).toBe("startup");
  });

  it("gives every surface the same verdict for the same row", () => {
    // Two mounted copies of the hook (the panel and the page) must agree.
    const stats = [session()];
    const a = renderHook(() =>
      useAgentSessions({ visible: false, roots: ["/repo"], stats, liveSessionIds: [] }),
    );
    const b = renderHook(() =>
      useAgentSessions({ visible: false, roots: ["/repo"], stats, liveSessionIds: [] }),
    );
    const la = a.result.current.lifeOf(a.result.current.sessions[0]);
    const lb = b.result.current.lifeOf(b.result.current.sessions[0]);
    expect(la.state).toBe(lb.state);
    expect(la.via).toBe(lb.via);
    expect(la.confidence).toBe(lb.confidence);
  });
});

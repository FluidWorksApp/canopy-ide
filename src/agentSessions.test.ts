// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type * as ipcTypes from "./ipc";
import { useAgentSessions } from "./agentSessions";

// Mutable seam so single tests can delay the claims-listener handshake.
const seams = vi.hoisted(() => ({
  onAgentClaims: undefined as (() => Promise<() => void>) | undefined,
  claims: [] as ipcTypes.AgentClaim[],
}));

vi.mock("./ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve([]),
  contextClaims: () => Promise.resolve(seams.claims),
  onAgentClaims: () => seams.onAgentClaims?.() ?? Promise.resolve(() => {}),
  contextMessages: () => Promise.resolve([]),
  onAgentMessage: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  sessionForget: () => Promise.resolve(),
}));

beforeEach(() => {
  seams.onAgentClaims = undefined;
  seams.claims = [];
});

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

const claim = (over: Partial<ipcTypes.AgentClaim> = {}): ipcTypes.AgentClaim => ({
  id: "c1",
  paths: ["/repo/src/auth.ts"],
  owner: "repo (/repo)",
  owner_key: "pty:7@inst-1",
  pty_id: 7,
  instance: "inst-1",
  note: null,
  at_ms: 1_000,
  released_at_ms: null,
  released_by: null,
  refusals: [],
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

describe("useAgentSessions identities", () => {
  it("keeps the derived lists stable across a re-render that changed nothing", () => {
    // agentSessions/termSessions used to be re-cut per render, which handed
    // AgentsPanel's auto-hibernation effect a fresh dependency every render —
    // and its over-the-cap toast fired on every stats tick. Same for
    // `restorable`, whose dep was the ids array's identity rather than its
    // contents (callers rebuild that array every render).
    const stats = [session({ id: 7 }), session({ id: 9, agent_hint: null })];
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useAgentSessions>[0]) => useAgentSessions(p),
      {
        initialProps: {
          visible: false,
          roots: ["/repo"],
          stats,
          liveSessionIds: ["s-1"],
        },
      },
    );
    const before = result.current;
    // New array identities, same contents — what every parent render produces.
    rerender({
      visible: false,
      roots: ["/repo"],
      stats,
      liveSessionIds: ["s-1"],
    });
    expect(result.current.agentSessions).toBe(before.agentSessions);
    expect(result.current.termSessions).toBe(before.termSessions);
    expect(result.current.restorable).toBe(before.restorable);
  });
});

describe("the claims listener", () => {
  it("only exposes claims that concern the active project's roots", async () => {
    seams.claims = [
      claim(),
      claim({
        id: "foreign",
        paths: ["/other/src/recording.rs"],
        owner: "other (/other)",
        owner_key: "pty:9@inst-1",
        pty_id: 9,
      }),
    ];
    const { result } = renderHook(() =>
      useAgentSessions({
        visible: true,
        roots: ["/repo"],
        stats: [session()],
        liveSessionIds: [],
      }),
    );
    await waitFor(() => expect(result.current.claims.map((item) => item.id)).toEqual(["c1"]));
  });

  it("unsubscribes even when listen() resolves after cleanup ran", async () => {
    // The race: the effect tore down before listen() resolved, so cleanup saw
    // `un === undefined` and the listener leaked for the rest of the run.
    const un = vi.fn();
    let hand!: (u: () => void) => void;
    seams.onAgentClaims = () => new Promise((res) => (hand = res));
    const { unmount } = renderHook(() =>
      useAgentSessions({
        visible: true,
        roots: ["/repo"],
        stats: [session()],
        liveSessionIds: [],
      }),
    );
    unmount();
    hand(un);
    await waitFor(() => expect(un).toHaveBeenCalled());
  });
});

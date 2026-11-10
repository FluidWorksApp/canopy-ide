import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSessions, resetProbeCache, runningSessions, PROBE_FAILURE_TTL_MS, PROBE_TTL_MS, type ProbeDeps } from "./workspaceProbe";

const conn = { endpoint: "https://w1.workspaces.canopyide.dev", token: "t", workspaceId: "w1" };
const session = (id: number, exitCode: number | null) => ({ id, title: "x", cols: 80, rows: 24, exitCode, accountId: null });

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps & { clock: { t: number } } {
  const clock = { t: 1000 };
  return {
    clock,
    connect: vi.fn(async () => conn),
    sessions: vi.fn(async () => [session(1, null), session(2, 0)]),
    clientId: () => "client-1",
    now: () => clock.t,
    ...over,
  };
}

beforeEach(() => resetProbeCache());

describe("probeSessions", () => {
  it("connects with a stable client id and lists the sessions", async () => {
    const d = deps();
    const out = await probeSessions("w1", d);
    expect(d.connect).toHaveBeenCalledWith("w1", "client-1");
    expect(d.sessions).toHaveBeenCalledWith(conn);
    expect(runningSessions(out)).toBe(1);
  });

  it("reuses a fresh listing and asks again once it is stale", async () => {
    const d = deps();
    await probeSessions("w1", d);
    await probeSessions("w1", d);
    expect(d.connect).toHaveBeenCalledTimes(1);
    d.clock.t += PROBE_TTL_MS + 1;
    await probeSessions("w1", d);
    expect(d.connect).toHaveBeenCalledTimes(2);
  });

  it("shares one request between simultaneous callers", async () => {
    const d = deps();
    await Promise.all([probeSessions("w1", d), probeSessions("w1", d)]);
    expect(d.connect).toHaveBeenCalledTimes(1);
  });

  it("remembers a failure briefly instead of waiting out the timeout again", async () => {
    const d = deps({ connect: vi.fn(async () => { throw new Error("stopped"); }) });
    await expect(probeSessions("w1", d)).rejects.toThrow("stopped");
    await expect(probeSessions("w1", d)).rejects.toThrow("stopped");
    expect(d.connect).toHaveBeenCalledTimes(1);
    d.clock.t += PROBE_FAILURE_TTL_MS + 1;
    await expect(probeSessions("w1", d)).rejects.toThrow("stopped");
    expect(d.connect).toHaveBeenCalledTimes(2);
  });

  it("forgets everything when the account changes", async () => {
    const d = deps();
    await probeSessions("w1", d);
    window.dispatchEvent(new Event("canopy:account-changed"));
    await probeSessions("w1", d);
    expect(d.connect).toHaveBeenCalledTimes(2);
  });
});

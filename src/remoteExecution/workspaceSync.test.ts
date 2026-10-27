import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionKey, reportConnection } from "./connectionState";
import { onWorkspaceConnect, runWorkspaceConnectTasks, startWorkspaceSync } from "./workspaceSync";

afterEach(() => vi.useRealTimers());

describe("workspace connect sync", () => {
  it("runs every task once on start and again after a reconnect, not on every flap", async () => {
    vi.useFakeTimers();
    const seen: string[][] = [];
    const off = onWorkspaceConnect("t", async (roots) => seen.push(roots));
    const key = connectionKey("https://e", "w1");
    reportConnection(key, "connected");
    const stop = startWorkspaceSync({ endpoint: "https://e", workspaceId: "w1", roots: () => ["/workspace/a"], settleMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toEqual([["/workspace/a"]]);
    reportConnection(key, "connected");
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toHaveLength(1);
    reportConnection(key, "reconnecting");
    reportConnection(key, "connected");
    reportConnection(key, "reconnecting");
    reportConnection(key, "connected");
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toHaveLength(2);
    stop();
    off();
  });

  it("one failing task never stops the others", async () => {
    const ran = vi.fn(async () => {});
    const offs = [onWorkspaceConnect("bad", async () => { throw Error("x"); }), onWorkspaceConnect("good", ran)];
    await runWorkspaceConnectTasks([]);
    expect(ran).toHaveBeenCalled();
    offs.forEach((off) => off());
  });
});

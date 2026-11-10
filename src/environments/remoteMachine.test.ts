import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "../host/contract";
import type { SessionDigest, SessionStats } from "../ipc";
import { aliasPty, resetPtyRoutes } from "./ptyRoute";
import { DIGEST_CLOCK_SLACK_SECS, rekeyDigests } from "./remoteDigests";
import { rekeyStats, remoteStats } from "./remoteStats";
import { remoteTabReconnect } from "./remoteReconnect";

const host = (invoke: (c: string) => unknown) => ({ invoke: vi.fn(async (c: string) => invoke(c)) }) as unknown as Host;

beforeEach(() => resetPtyRoutes());

describe("digests of a remote tab", () => {
  const digest = (surface: string, updated: number) => ({ session_id: "s", surface, updated }) as unknown as SessionDigest;

  it("drops one last written before the tab started, keeps one written after", () => {
    const alias = aliasPty("remote:w", 3, host(() => []), false);
    const launchedAt = new Map([[alias, 1_000_000_000_000]]);
    const t = 1_000_000_000;
    const old = digest("3", t - DIGEST_CLOCK_SLACK_SECS - 10);
    const fresh = digest("3", t + 5);
    expect(rekeyDigests("remote:w", [old], null, launchedAt)).toEqual([]);
    expect(rekeyDigests("remote:w", [fresh], null, launchedAt)).toHaveLength(1);
  });

  it("tolerates a machine clock a little behind, and without a launch time keeps everything", () => {
    const alias = aliasPty("remote:w", 3, host(() => []), false);
    const t = 1_000_000_000;
    const slightlyBehind = digest("3", t - 5);
    expect(rekeyDigests("remote:w", [slightlyBehind], null, new Map([[alias, t * 1000]]))).toHaveLength(1);
    expect(rekeyDigests("remote:w", [digest("3", 1)], null)).toHaveLength(1);
  });
});

describe("remote terminal stats", () => {
  const row = (id: number) => ({ id, title: "t", cwd: "/", total_cpu: 1, total_mem_bytes: 1, procs: [], ports: [], agent_hint: null, quiet_ms: null }) as unknown as SessionStats;

  it("re-keys to alias ids and ignores terminals this window did not start", () => {
    const alias = aliasPty("remote:w", 7, host(() => []), false);
    expect(rekeyStats("remote:w", [row(7), row(8)]).map((r) => r.id)).toEqual([alias]);
  });

  it("adds nothing for a silent machine and never delays the others", async () => {
    aliasPty("remote:a", 1, host(() => []), false);
    const alias = aliasPty("remote:b", 2, host(() => []), false);
    const slow = { env: "remote:a", host: { invoke: () => new Promise(() => {}) } as unknown as Host };
    const good = { env: "remote:b", host: host(() => [row(2)]) };
    const rows = await remoteStats([slow, good], 20);
    expect(rows.map((r) => r.id)).toEqual([alias]);
  });

  it("is empty with no machines", async () => {
    expect(await remoteStats([])).toEqual([]);
  });
});

describe("reconnecting a remote tab", () => {
  const machine = (stats: unknown) => ({
    env: "remote:w",
    name: "Workstation",
    host: host(() => []),
    readOnly: false,
    invoke: vi.fn(async () => stats) as never,
  });

  it("reattaches a session that is still running, under an alias", async () => {
    const adopt = vi.fn(() => 2 ** 40 + 1);
    const result = await remoteTabReconnect("remote:w", 5, { connect: async () => machine([{ id: 5 }]), adopt });
    expect(result).toEqual({ kind: "attached", alias: 2 ** 40 + 1, machineName: "Workstation" });
    expect(adopt).toHaveBeenCalledWith({ id: "remote:w", host: expect.anything(), readOnly: false }, 5);
  });

  it("says so when the session has ended, and attaches nothing", async () => {
    const adopt = vi.fn();
    const result = await remoteTabReconnect("remote:w", 5, { connect: async () => machine([{ id: 6 }]), adopt });
    expect(result).toEqual({ kind: "gone", machineName: "Workstation" });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("reports an unreachable machine and a non-workspace id", async () => {
    const failed = await remoteTabReconnect("remote:w", 5, { connect: async () => { throw new Error("down"); }, adopt: vi.fn() });
    expect(failed).toMatchObject({ kind: "failed" });
    expect(await remoteTabReconnect("local", 5, { connect: vi.fn(), adopt: vi.fn() })).toMatchObject({ kind: "failed" });
  });
});

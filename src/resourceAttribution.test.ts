import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./teamIdentity", () => ({ peekTeamIdentity: vi.fn(() => null), teamIdentity: vi.fn(async () => null) }));

import * as identity from "./teamIdentity";
import {
  attributeUsage,
  CPU_LOW_SAMPLES,
  cpuShort,
  memoryAvailability,
  nextCpuStreak,
  selfOwnerId,
  terminalOwner,
} from "./resourceAttribution";

const GB = 1024 ** 3;
const me = { id: "u-me", name: "Me" };
const ada = { id: "u-ada", name: "Ada" };
const bo = { id: "u-bo", name: "Bo" };

describe("attributeUsage", () => {
  it("groups terminals by who started them; services are what the terminals don't explain", () => {
    const rows = attributeUsage(
      [
        { id: 1, memoryBytes: 1 * GB, cpusUsed: 0.5, owner: me },
        { id: 2, memoryBytes: 0.5 * GB, cpusUsed: 0.25, owner: bo },
        { id: 3, memoryBytes: 2 * GB, cpusUsed: 1, owner: ada },
        { id: 4, memoryBytes: 1 * GB, cpusUsed: 0, owner: me },
        { id: 5, memoryBytes: 0.5 * GB, cpusUsed: 0, owner: null },
      ],
      { workingSetBytes: 8 * GB, cpusUsed: 3 },
      "u-me",
    );
    expect(rows.map((r) => [r.kind, r.label, r.memoryBytes / GB, r.cpusUsed, r.terminals])).toEqual([
      ["you", "You", 2, 0.5, 2],
      ["teammate", "Ada", 2, 1, 1],
      ["teammate", "Bo", 0.5, 0.25, 1],
      ["unknown", "Terminals from older versions", 0.5, 0, 1],
      ["services", "Workspace services", 3, 1.25, 0],
    ]);
  });

  it("always lists you, and never makes services negative", () => {
    const rows = attributeUsage([{ id: 1, memoryBytes: 9 * GB, cpusUsed: 4, owner: ada }], { workingSetBytes: 8 * GB, cpusUsed: null }, "u-me");
    expect(rows[0]).toMatchObject({ kind: "you", memoryBytes: 0, terminals: 0 });
    expect(rows.at(-1)).toMatchObject({ kind: "services", memoryBytes: 0, cpusUsed: null });
  });
});

describe("thresholds", () => {
  it("memory warns on what is free of the limit", () => {
    expect(memoryAvailability(20 * GB, 28.8 * GB)).toBe("ok");
    expect(memoryAvailability(4 * GB, 28.8 * GB)).toBe("low");
    expect(memoryAvailability(1.5 * GB, 28.8 * GB)).toBe("critical");
    expect(memoryAvailability(null, 28.8 * GB)).toBe("ok");
    expect(memoryAvailability(0, null)).toBe("ok");
  });

  it("CPU is short under one core free (a quarter on small workspaces), and only after a run of samples", () => {
    expect(cpuShort(0.9, 8)).toBe(true);
    expect(cpuShort(1.1, 8)).toBe(false);
    expect(cpuShort(0.6, 2)).toBe(false);
    expect(cpuShort(0.4, 2)).toBe(true);
    expect(cpuShort(null, 8)).toBe(false);
    let streak = 0;
    for (let i = 0; i < CPU_LOW_SAMPLES + 3; i++) streak = nextCpuStreak(streak, 0.2, 8);
    expect(streak).toBe(CPU_LOW_SAMPLES);
    expect(nextCpuStreak(streak, 3, 8)).toBe(0);
  });
});

describe("owner identity", () => {
  beforeEach(() => localStorage.clear());

  it("is the signed-in account, else a stable id for this desktop", async () => {
    vi.mocked(identity.peekTeamIdentity).mockReturnValue({ id: "u-me", name: "Me", email: "" });
    expect(selfOwnerId()).toBe("u-me");
    expect(await terminalOwner()).toEqual({ id: "u-me", name: "Me" });
    vi.mocked(identity.peekTeamIdentity).mockReturnValue(null);
    const device = selfOwnerId();
    expect(device).toMatch(/^device:/);
    expect(selfOwnerId()).toBe(device);
    expect((await terminalOwner(5)).id).toBe(device);
  });
});

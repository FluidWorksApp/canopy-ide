import { describe, expect, it, vi } from "vitest";
import { MachineReads, readMachine } from "./useAllWorkspacesPlan";
import type { MachineRead } from "./allProjects";

const read = (name: string): MachineRead => ({ env: "remote:a", name, projects: [], openIds: [], sessions: [] });

describe("MachineReads", () => {
  it("keeps a machine's last read through a failed pass, and waits before asking again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 0;
    const reads = new MachineReads<string>(() => t);
    expect((await reads.get("a", async () => ({ read: read("first"), machine: "m" })))?.read.name).toBe("first");
    // Times out: what it showed last time stays.
    expect((await reads.get("a", async () => Promise.reject(new Error("timed out"))))?.read.name).toBe("first");
    // Within the wait it is not asked at all.
    const run = vi.fn(async () => ({ read: read("second"), machine: "m" }));
    t = 30_000;
    expect((await reads.get("a", run))?.read.name).toBe("first");
    expect(run).not.toHaveBeenCalled();
    t = 61_000;
    expect((await reads.get("a", run))?.read.name).toBe("second");
  });

  it("has nothing for a machine never read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reads = new MachineReads<string>();
    expect(await reads.get("b", async () => Promise.reject(new Error("no")))).toBeUndefined();
  });
});

describe("readMachine", () => {
  it("reads the store text and the live terminals", async () => {
    const invoke = vi.fn(async (command: string) =>
      command === "store_load"
        ? JSON.stringify({ projects: [{ id: "p", name: "P", components: [] }], openIds: ["p"] })
        : [{ id: 4, cwd: "/w/p", title: "agent" }, { id: "bad" }],
    ) as never;
    const got = await readMachine("remote:a", "A very long workspace name", invoke);
    expect(got.name).toBe("A very long wo");
    expect(got.openIds).toEqual(["p"]);
    expect(got.sessions).toEqual([{ id: 4, cwd: "/w/p", title: "agent" }]);
  });
});

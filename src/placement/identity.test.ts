import { describe, expect, it } from "vitest";
import { canonicalProjectId, canonicalProjects, counterpartOf } from "./identity";

const mac = { id: "mac-1", name: "Canopy" };
const copy = { id: "ws-9", name: "Canopy", mirroredFrom: "mac-1" };

describe("project identity across machines", () => {
  it("a complete mirror goes by the Mac's id, anything else by its own", () => {
    expect(canonicalProjectId(copy)).toBe("mac-1");
    expect(canonicalProjectId(mac)).toBe("mac-1");
    expect(canonicalProjectId({ id: "native", name: "Made on the workspace" })).toBe("native");
  });

  it("a copy still being set up is not the same project yet", () => {
    expect(canonicalProjectId({ ...copy, mirrorIncomplete: true })).toBe("ws-9");
  });

  it("never matches by name: two different projects named alike stay different", () => {
    const other = { id: "ws-2", name: "Canopy" };
    expect(counterpartOf(other, [mac])).toBeUndefined();
    expect(counterpartOf(copy, [mac])).toBe(mac);
    expect(counterpartOf(mac, [copy, other])).toBe(copy);
  });

  it("recognises a project brought back from a workspace through an explicit link, never by name", () => {
    const native = { id: "ws-native", name: "Dashboard" };
    const local = { id: "mac-7", name: "Dashboard", linkedTo: [{ env: "remote:ws", id: "ws-native" }] };
    expect(counterpartOf(native, [local])).toBe(local);
    expect(counterpartOf(local, [native], "remote:ws")).toBe(native);
    // The link names a machine: another machine's project with the same id is not it.
    expect(counterpartOf(local, [native], "remote:other")).toBeUndefined();
    expect(counterpartOf({ id: "x", name: "Dashboard" }, [local])).toBeUndefined();
  });

  it("lists a workspace's projects under the ids the Mac knows them by, once each", () => {
    expect(canonicalProjects([copy, { id: "ws-3", name: "Canopy again", mirroredFrom: "mac-1" }, { id: "n", name: "N" }])).toEqual([
      { id: "mac-1", name: "Canopy" },
      { id: "n", name: "N" },
    ]);
  });
});

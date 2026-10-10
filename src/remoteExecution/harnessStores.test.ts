import { afterEach, describe, expect, it } from "vitest";
import { resetRemoteHarnessForTest, setRemoteStore, withRemoteMesh } from "./harnessStores";

afterEach(() => resetRemoteHarnessForTest());

describe("remote mesh history", () => {
  it("returns local rows untouched when no service reports", () => {
    const local = [{ id: "m1", at_ms: 5 }];
    expect(withRemoteMesh(local)).toBe(local);
  });

  it("namespaces remote ids and reply pointers and interleaves by time", () => {
    setRemoteStore("svc", "ws-a", "mesh", { items: [
      { id: "m1", at_ms: 3, reply_to: null },
      { id: "m2", at_ms: 9, reply_to: "m1" },
      { id: "bad" },
    ] });
    const merged = withRemoteMesh([{ id: "m1", at_ms: 5, reply_to: null as string | null }]);
    expect(merged.map((m) => m.id)).toEqual(["ws:ws-a/m1", "m1", "ws:ws-a/m2"]);
    expect(merged[2].reply_to).toBe("ws:ws-a/m1");
  });
});

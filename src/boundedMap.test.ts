import { describe, expect, it } from "vitest";
import { setBounded } from "./boundedMap";

describe("setBounded", () => {
  it("evicts the least-recently-written entry", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "c", 3, 2);
    expect([...map.entries()]).toEqual([
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("refreshes an updated entry without growing the cache", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "a", 3, 2);
    setBounded(map, "c", 4, 2);
    expect([...map.entries()]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });
});

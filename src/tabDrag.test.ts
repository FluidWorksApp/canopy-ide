import { describe, expect, it } from "vitest";
import { applyOrder } from "./tabDrag";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("applyOrder", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("reorders the whole list", () => {
    expect(ids(applyOrder(list, (t) => t.id, ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });

  it("keeps items outside the dragged group in their own slots", () => {
    // Agents and docs are separate groups in one array: reordering the docs
    // must not shuffle an agent tab sitting between them.
    const mixed = [{ id: "doc1" }, { id: "agent" }, { id: "doc2" }, { id: "doc3" }];
    expect(ids(applyOrder(mixed, (t) => t.id, ["doc3", "doc1", "doc2"]))).toEqual([
      "doc3",
      "agent",
      "doc1",
      "doc2",
    ]);
  });

  it("ignores ids that are no longer in the list", () => {
    expect(ids(applyOrder(list, (t) => t.id, ["b", "gone", "a"]))).toEqual(["b", "a", "c"]);
  });

  it("leaves the list alone for an unchanged order", () => {
    expect(ids(applyOrder(list, (t) => t.id, ["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });
});

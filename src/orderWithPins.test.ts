import { describe, expect, it } from "vitest";
import { orderWithPins } from "./projects";

const projects = [
  { id: "a" },
  { id: "b", pinned: true },
  { id: "c" },
  { id: "d", pinned: true },
];

describe("orderWithPins", () => {
  it("puts pinned projects first and keeps each group's order", () => {
    expect(orderWithPins(["a", "b", "c", "d"], projects)).toEqual(["b", "d", "a", "c"]);
  });
  it("pulls a pinned tab back to the front after it was dragged behind others", () => {
    expect(orderWithPins(["a", "c", "d", "b"], projects)).toEqual(["d", "b", "a", "c"]);
  });
  it("leaves the order alone when nothing is pinned", () => {
    expect(orderWithPins(["c", "a"], [{ id: "a" }, { id: "c" }])).toEqual(["c", "a"]);
  });
  it("ignores a pinned project that is not open", () => {
    expect(orderWithPins(["a", "c"], projects)).toEqual(["a", "c"]);
  });
});

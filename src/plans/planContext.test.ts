import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  fsReadDir: vi.fn(async () => [
    { name: "src", is_dir: true },
    { name: ".git", is_dir: true },
    { name: "package.json", is_dir: false },
  ]),
  fsSearch: vi.fn(async () => []),
}));

import { gatherPlanContext } from "./planContext";

describe("gatherPlanContext", () => {
  it("lists the repo's top level without dotfiles", async () => {
    const context = await gatherPlanContext("/repo", "add billing");
    expect(context.tree).toEqual(["src/", "package.json"]);
    expect(context.relevant).toEqual([]);
  });
});

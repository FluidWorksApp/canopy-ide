import { describe, expect, it, vi } from "vitest";
import { listComponentFiles } from "./Palette";

describe("listComponentFiles", () => {
  it("keeps the other components when one cannot be listed", async () => {
    const list = vi.fn(async (roots: string[]) => {
      if (roots[0] === "/bad") throw new Error("outside workspace scope");
      return [`${roots[0]}/Cargo.toml`];
    });
    expect(await listComponentFiles(["/a", "/bad", "/b"], list)).toEqual(["/a/Cargo.toml", "/b/Cargo.toml"]);
  });

  it("gives every component its own budget so a large one cannot starve the rest", async () => {
    const list = vi.fn(async (roots: string[], limit?: number) => [`${roots[0]}:${limit}`]);
    await listComponentFiles(["/a", "/b"], list);
    expect(list).toHaveBeenCalledWith(["/a"], 12000);
    expect(list).toHaveBeenCalledWith(["/b"], 12000);
  });

  it("lists a single component in one call and tolerates failure", async () => {
    const list = vi.fn(async () => {
      throw new Error("x");
    });
    expect(await listComponentFiles(["/a"], list)).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

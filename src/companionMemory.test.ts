import { beforeEach, describe, expect, it, vi } from "vitest";

// The store is one file under ~/.canopy/companion; these tests are about what
// gets kept and what gets merged, not about the disk.
const disk = new Map<string, string>();
vi.mock("./ipc", () => ({
  canopyStoreRead: (name: string) => Promise.resolve(disk.get(name) ?? null),
  canopyStoreWrite: (name: string, body: string) => {
    disk.set(name, body);
    return Promise.resolve();
  },
}));

const fresh = async () => {
  disk.clear();
  vi.resetModules();
  return import("./companionMemory");
};

beforeEach(() => disk.clear());

describe("remembering", () => {
  it("keeps a fact and hands it back", async () => {
    const m = await fresh();
    await m.remember({ fact: "Prefers worktrees over branch switching", about: "how they work" });
    const found = m.recallFrom(await m.loadMemories());
    expect(found).toHaveLength(1);
    expect(found[0].fact).toContain("worktrees");
  });

  it("defaults `about` rather than losing the fact", async () => {
    const m = await fresh();
    await m.remember({ fact: "Ships on Fridays" });
    expect((await m.loadMemories())[0].about).toBe("how they work");
  });

  it("does not keep the same thing twice when told again", async () => {
    // The companion will re-learn things — told in March, told again in July.
    // Two rows saying it is how a memory turns into noise.
    const m = await fresh();
    await m.remember({ fact: "Prefers worktrees", about: "how they work" });
    await m.remember({
      fact: "Prefers worktrees over switching branches in place",
      about: "how they work",
    });
    const all = await m.loadMemories();
    expect(all).toHaveLength(1);
    // The newer, fuller wording wins.
    expect(all[0].fact).toContain("over switching branches");
  });

  it("keeps the same words about different things apart", async () => {
    const m = await fresh();
    await m.remember({ fact: "Uses pnpm", about: "Canopy" });
    await m.remember({ fact: "Uses pnpm", about: "Banana" });
    expect(await m.loadMemories()).toHaveLength(2);
  });

  it("retracts a fact that turned out to be wrong", async () => {
    const m = await fresh();
    await m.remember({ fact: "Deploys on Fridays", about: "how they work" });
    const out = await m.remember({
      fact: "Deploys on Fridays",
      about: "how they work",
      forget: true,
    });
    expect(out.action).toBe("forgotten");
    expect(await m.loadMemories()).toHaveLength(0);
  });

  it("reports forgetting something that was never there, rather than pretending", async () => {
    const m = await fresh();
    const out = await m.remember({ fact: "never said", about: "x", forget: true });
    expect(out.action).toBe("ignored");
  });

  it("refuses an empty fact", async () => {
    const m = await fresh();
    expect((await m.remember({ fact: "   " })).action).toBe("ignored");
    expect(await m.loadMemories()).toHaveLength(0);
  });

  it("caps what it keeps, dropping the oldest", async () => {
    const m = await fresh();
    for (let i = 0; i < m.MAX_MEMORIES + 10; i++) {
      await m.remember({ fact: `fact number ${i}`, about: `topic ${i}` });
    }
    const all = await m.loadMemories();
    expect(all).toHaveLength(m.MAX_MEMORIES);
    // The newest survive — they are the ones most likely still true.
    expect(all[all.length - 1].fact).toContain(`${m.MAX_MEMORIES + 9}`);
    expect(all.some((x) => x.fact === "fact number 0")).toBe(false);
  });
});

describe("recalling", () => {
  it("is newest-first when nothing is asked for", async () => {
    const m = await fresh();
    await m.remember({ fact: "older", about: "a" });
    await m.remember({ fact: "newer", about: "b" });
    const found = m.recallFrom(await m.loadMemories());
    expect(found[0].fact).toBe("newer");
  });

  it("narrows to what matches, on either the topic or the fact", async () => {
    const m = await fresh();
    await m.remember({ fact: "Uses pnpm, never npm", about: "Canopy" });
    await m.remember({ fact: "Android build needs the NDK", about: "Banana" });
    expect(m.recallFrom(await m.loadMemories(), "pnpm").map((x) => x.about)).toEqual(["Canopy"]);
    expect(m.recallFrom(await m.loadMemories(), "Banana").map((x) => x.about)).toEqual(["Banana"]);
  });

  it("returns nothing rather than everything when nothing matches", async () => {
    // Falling back to the whole set would have the companion answer a specific
    // question with unrelated facts, which reads as confabulation.
    const m = await fresh();
    await m.remember({ fact: "Uses pnpm", about: "Canopy" });
    expect(m.recallFrom(await m.loadMemories(), "kubernetes")).toEqual([]);
  });

  it("survives a corrupt store instead of failing the turn", async () => {
    const m = await fresh();
    disk.set(m.MEMORY_FILE, "{ this is not json");
    expect(await m.loadMemories()).toEqual([]);
  });
});

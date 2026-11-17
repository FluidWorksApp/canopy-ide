import { beforeEach, describe, expect, it } from "vitest";
import { snapshotTabs, type SnapshotTab } from "./hibernation";
import type { SubTab } from "./components/ProjectView/helpers";
import { MAX_PINNED_TABS, pinnedDocuments, pinsToRestore, rememberPinnedTabs, rememberedPinnedTabs, snapshotTabKey } from "./pinnedTabs";

const file = (path: string, pinned = true): SnapshotTab => ({ kind: "file", path, view: "source", ...(pinned ? { pinned: true } : {}) });

beforeEach(() => localStorage.clear());

describe("pinned tabs across a restart", () => {
  it("remembers pinned documents and leaves terminals and unpinned tabs out", () => {
    rememberPinnedTabs("p1", [
      file("/w/a.ts"),
      file("/w/b.ts", false),
      { kind: "terminal", cwd: "/w", title: "shell", pinned: true },
      { kind: "notes-list", pinned: true },
    ]);
    expect(rememberedPinnedTabs("p1")).toEqual([file("/w/a.ts"), { kind: "notes-list", pinned: true }]);
  });

  it("remembers that the last pin was removed", () => {
    rememberPinnedTabs("p1", [file("/w/a.ts")]);
    rememberPinnedTabs("p1", [file("/w/a.ts", false)]);
    expect(rememberedPinnedTabs("p1")).toEqual([]);
  });

  it("keeps each project and each machine's pins apart", () => {
    rememberPinnedTabs("p1", [file("/w/a.ts")]);
    rememberPinnedTabs("p1", [file("/workspace/a.ts")], "workspace:w9");
    rememberPinnedTabs("p2", [file("/w/z.ts")]);
    expect(rememberedPinnedTabs("p1").map(snapshotTabKey)).toEqual(["file:/w/a.ts"]);
    expect(rememberedPinnedTabs("p1", "workspace:w9").map(snapshotTabKey)).toEqual(["file:/workspace/a.ts"]);
    expect(rememberedPinnedTabs("p2").map(snapshotTabKey)).toEqual(["file:/w/z.ts"]);
    expect(rememberedPinnedTabs("p3")).toEqual([]);
  });

  it("survives a damaged store", () => {
    localStorage.setItem("canopy.pinnedTabs.v1", "{not json");
    expect(rememberedPinnedTabs("p1")).toEqual([]);
    localStorage.setItem("canopy.pinnedTabs.v1", JSON.stringify({ p1: [null, 7, { kind: "file", path: "/w/a.ts", view: "source", pinned: true }, { path: "x" }] }));
    expect(rememberedPinnedTabs("p1")).toEqual([file("/w/a.ts")]);
    localStorage.setItem("canopy.pinnedTabs.v1", JSON.stringify({ p1: "nope" }));
    expect(rememberedPinnedTabs("p1")).toEqual([]);
  });

  it("never remembers more than the cap, nor the same tab twice", () => {
    const many = Array.from({ length: MAX_PINNED_TABS + 10 }, (_, i) => file(`/w/${i}.ts`));
    expect(pinnedDocuments([...many, file("/w/0.ts")])).toHaveLength(MAX_PINNED_TABS);
    expect(pinnedDocuments([file("/w/a.ts"), { ...file("/w/a.ts"), view: "preview" } as SnapshotTab])).toHaveLength(1);
  });

  it("restores only the pins the strip does not already show", () => {
    const remembered = [file("/w/a.ts"), file("/w/b.ts"), { kind: "prs-list", pinned: true } as SnapshotTab];
    const open = [{ ...file("/w/a.ts", false), view: "diff" } as SnapshotTab, { kind: "prs-list" } as SnapshotTab];
    expect(pinsToRestore(remembered, open).map(snapshotTabKey)).toEqual(["file:/w/b.ts"]);
  });

  it("identifies a pull request by its number, not its changing details", () => {
    const pr = (title: string) => ({ kind: "pr", repo: "/w", pr: { number: 12, title } }) as unknown as SnapshotTab;
    expect(snapshotTabKey(pr("Old title"))).toBe(snapshotTabKey(pr("New title")));
  });
});

describe("snapshotTabs", () => {
  it("records the pin on every kind of tab, not just terminals", () => {
    const tabs = [
      { id: "1", type: "file", pinned: true, file: { path: "/w/a.ts", view: "source" } },
      { id: "2", type: "notes-list", pinned: true },
      { id: "3", type: "prs-list" },
      { id: "4", type: "terminal", cwd: "/w", ptyId: 1, pinned: true },
    ] as unknown as SubTab[];
    expect(snapshotTabs(tabs).map((t) => [t.kind, t.pinned === true])).toEqual([
      ["file", true],
      ["notes-list", true],
      ["prs-list", false],
      ["terminal", true],
    ]);
  });
});

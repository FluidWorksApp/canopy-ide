import { describe, expect, it } from "vitest";
import {
  autoExpanded,
  patchStats,
  AUTO_EXPAND_FILE,
  AUTO_EXPAND_TOTAL,
} from "./patchBudget";

const hunk = (adds: number, dels: number) =>
  [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    " context",
    ...Array.from({ length: adds }, (_, i) => `+added ${i}`),
    ...Array.from({ length: dels }, (_, i) => `-removed ${i}`),
  ].join("\n");

describe("patchStats", () => {
  it("counts hunk lines and not the file headers", () => {
    // The `---`/`+++` pair would otherwise read as one deletion and one
    // addition on every single file.
    expect(patchStats(hunk(3, 2))).toEqual({
      additions: 3,
      deletions: 2,
      changed: 5,
      binary: false,
    });
  });

  it("recognises a binary file, in both spellings git uses", () => {
    expect(
      patchStats("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ")
        .binary,
    ).toBe(true);
    expect(
      patchStats("diff --git a/i.png b/i.png\nGIT binary patch\nliteral 12").binary,
    ).toBe(true);
  });

  it("counts nothing in an empty patch", () => {
    expect(patchStats("")).toEqual({
      additions: 0,
      deletions: 0,
      changed: 0,
      binary: false,
    });
  });
});

describe("autoExpanded", () => {
  const file = (path: string, changed: number, binary = false) => ({
    path,
    changed,
    binary,
  });

  it("opens everything when the whole patch is small", () => {
    const files = [file("a", 10), file("b", 20), file("big.bin", 5, true)];
    expect(autoExpanded(files)).toEqual(new Set(["a", "b", "big.bin"]));
  });

  it("opens nothing at all for an empty patch", () => {
    expect(autoExpanded([])).toEqual(new Set());
  });

  it("leaves a lockfile collapsed and still opens the source beside it", () => {
    const files = [
      file("package-lock.json", 30_000),
      file("src/a.ts", 40),
      file("src/b.ts", 60),
    ];
    expect(autoExpanded(files)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  it("skips a single file bigger than the per-file ceiling", () => {
    const files = [
      file("huge.ts", AUTO_EXPAND_FILE + 1),
      file("also-huge.ts", AUTO_EXPAND_FILE + 1),
      file("still-huge.ts", AUTO_EXPAND_FILE + 1),
      file("small.ts", 5),
    ];
    // Past AUTO_EXPAND_TOTAL overall, so the per-file rule is the one in play
    // — under it, every one of these would simply open.
    expect(files.reduce((n, f) => n + f.changed, 0)).toBeGreaterThan(
      AUTO_EXPAND_TOTAL,
    );
    expect(autoExpanded(files)).toEqual(new Set(["small.ts"]));
  });

  it("never opens a binary file, however small it claims to be", () => {
    const files = [file("noise.ts", 30_000), file("icon.png", 0, true)];
    expect(autoExpanded(files)).toEqual(new Set());
  });

  it("stops once the budget is spent, and does not resume on a later small file", () => {
    // Order is the patch's own: everything after the budget runs out stays
    // collapsed, which is what makes "what will be open?" answerable.
    const files = [
      file("a", 190),
      file("b", 190),
      file("c", 190),
      file("d", 190),
      file("e", 190),
      file("f", 190),
      file("g", 190),
    ];
    const open = autoExpanded(files);
    expect(open.has("a")).toBe(true);
    expect(open.size).toBe(6); // 6 × 190 = 1140, under the 1200 budget; the 7th is not
    expect(open.has("g")).toBe(false);
  });
});

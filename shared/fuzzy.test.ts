import { describe, expect, it } from "vitest";
import { fuzzy, fuzzyRanges, pathScore } from "./fuzzy";

/** Lower is better, so "ranks above" reads backwards in a raw comparison. */
const better = (needle: string, win: string, lose: string) => {
  const a = fuzzy(needle, win);
  const b = fuzzy(needle, lose);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!).toBeLessThan(b!);
};

describe("fuzzy", () => {
  it("keeps the cost convention every call site sorts by", () => {
    // Ascending sorts and the hand-pinned -2/-1/-0.5 rows in spotSources.ts
    // both depend on this: a match is never negative, and an empty needle is
    // free.
    expect(fuzzy("", "anything")).toBe(0);
    for (const hay of ["SpotSearch.tsx", "a", "src/spotSources.ts", "x".repeat(200)]) {
      const s = fuzzy("s", hay);
      if (s !== null) expect(s).toBeGreaterThanOrEqual(0);
    }
    expect(fuzzy("zzz", "SpotSearch.tsx")).toBeNull();
  });

  it("matches space-separated terms independently", () => {
    // The headline defect: the product's own name returned nothing, because
    // the space had to appear literally in the haystack.
    expect(fuzzy("spot search", "src/components/SpotSearch.tsx")).not.toBeNull();
    expect(fuzzy("spot search", "SpotSearch.tsx")).not.toBeNull();
    // Order between terms doesn't matter — each is matched on its own.
    expect(fuzzy("search spot", "SpotSearch.tsx")).not.toBeNull();
    // But every term still has to match.
    expect(fuzzy("spot nothinglikethis", "SpotSearch.tsx")).toBeNull();
  });

  it("takes an escaped space as a literal one", () => {
    expect(fuzzy("spot\\ search", "SpotSearch.tsx")).toBeNull();
    expect(fuzzy("spot\\ search", "the spot search box")).not.toBeNull();
  });

  it("ranks word and camelCase boundaries above mid-word letters", () => {
    // "sps" used to be a five-way tie at score 3, broken by corpus order.
    better("sps", "SpotSearch.tsx", "snapshot.rs");
    better("sps", "spotSources.ts", "snapshot.rs");
    better("cm", "ContextMenu.tsx", "commit.rs");
  });

  it("prefers a match that starts a word", () => {
    better("fuzzy", "shared/fuzzy.ts", "obfuzzycated.ts");
    better("run", "run-task", "overrun");
  });

  it("scores a path delimiter as a boundary", () => {
    expect(fuzzy("src/fuzzy", "src/fuzzy.ts")).not.toBeNull();
    better("srcfuzz", "src/fuzzy.ts", "resourcefuzzled.ts");
  });

  it("charges nothing for how deep the checkout is", () => {
    // The old fallback scored the absolute path from position zero, so the same
    // repo ranked differently on two machines. The window starts at the first
    // character that can begin a match, so the prefix is never scored.
    const q = "src/fuzzy";
    const deep = "/Users/somebody/Documents/GitHub/canopy/src/fuzzy.ts";
    expect(fuzzy(q, deep)).toBe(fuzzy(q, "/a/src/fuzzy.ts"));
    expect(fuzzy(q, deep)).toBeLessThan(20);
  });
});

describe("fuzzy operators", () => {
  it("'exact takes a literal run, not a subsequence", () => {
    expect(fuzzy("spotsearch", "s.p.o.t.s.e.a.r.c.h")).not.toBeNull();
    expect(fuzzy("'spotsearch", "s.p.o.t.s.e.a.r.c.h")).toBeNull();
    expect(fuzzy("'spotsearch", "SpotSearch.tsx")).not.toBeNull();
  });

  it("^ anchors a prefix and $ a suffix", () => {
    expect(fuzzy("^spot", "SpotSearch.tsx")).not.toBeNull();
    expect(fuzzy("^search", "SpotSearch.tsx")).toBeNull();
    expect(fuzzy(".tsx$", "SpotSearch.tsx")).not.toBeNull();
    expect(fuzzy(".ts$", "SpotSearch.tsx")).toBeNull();
    // Both together is equality.
    expect(fuzzy("^SpotSearch.tsx$", "SpotSearch.tsx")).not.toBeNull();
    expect(fuzzy("^SpotSearch$", "SpotSearch.tsx")).toBeNull();
  });

  it("! excludes, and excludes literally", () => {
    expect(fuzzy("search !tsx", "SpotSearch.tsx")).toBeNull();
    expect(fuzzy("search !tsx", "SpotSearch.rs")).not.toBeNull();
    // A negated term is exact in fzf, so it does not exclude by resemblance.
    expect(fuzzy("!tsx", "t.s.x")).not.toBeNull();
    expect(fuzzy("!^spot", "SpotSearch.tsx")).toBeNull();
    expect(fuzzy("!.tsx$", "SpotSearch.tsx")).toBeNull();
  });

  it("keeps an operator with nothing behind it harmless", () => {
    // Mid-typing states: "^" then the word, "!" then the word.
    for (const q of ["^", "!", "$", "'"]) expect(fuzzy(q, "SpotSearch.tsx")).not.toBeUndefined();
    expect(fuzzy("^", "SpotSearch.tsx")).toBe(0);
  });
});

describe("fuzzyRanges", () => {
  it("agrees with fuzzy about whether it matched", () => {
    const cases: [string, string][] = [
      ["spot search", "SpotSearch.tsx"],
      ["sps", "snapshot.rs"],
      ["'spot", "SpotSearch.tsx"],
      ["^search", "SpotSearch.tsx"],
      ["search !tsx", "SpotSearch.tsx"],
      ["zzz", "SpotSearch.tsx"],
      ["", "SpotSearch.tsx"],
    ];
    for (const [q, hay] of cases)
      expect([q, hay, fuzzyRanges(q, hay) === null]).toEqual([q, hay, fuzzy(q, hay) === null]);
  });

  it("returns sorted, merged, non-overlapping ranges", () => {
    const hay = "src/components/SpotSearch.tsx";
    const ranges = fuzzyRanges("spot search", hay)!;
    expect(ranges.length).toBeGreaterThan(0);
    let at = -1;
    for (const [start, end] of ranges) {
      expect(start).toBeGreaterThan(at);
      expect(end).toBeGreaterThan(start);
      at = end - 1;
    }
    expect(ranges.map(([s, e]) => hay.slice(s, e)).join("")).toBe("SpotSearch");
  });

  it("is empty for an empty needle", () => {
    expect(fuzzyRanges("", "SpotSearch.tsx")).toEqual([]);
  });
});

describe("pathScore", () => {
  it("lets the name win when the name matches", () => {
    const q = "fuzzy";
    expect(pathScore(q, "shared/fuzzy.ts")).toBe(fuzzy(q, "fuzzy.ts"));
  });

  it("falls through to the whole path for a query with a separator", () => {
    const q = "shared/fuzzy";
    expect(fuzzy(q, "fuzzy.ts")).toBeNull();
    expect(pathScore(q, "shared/fuzzy.ts")).not.toBeNull();
  });

  it("returns null only when neither matches", () => {
    expect(pathScore("zzz", "shared/fuzzy.ts")).toBeNull();
  });
});

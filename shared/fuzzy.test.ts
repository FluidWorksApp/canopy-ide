import { describe, expect, it } from "vitest";
import { fuzzy, fuzzyLower } from "./fuzzy";

describe("fuzzyLower", () => {
  // Quick-open lowercases its corpus once and calls this directly, so the two
  // must not be able to disagree about what matches or how it ranks.
  it("agrees with fuzzy for every casing", () => {
    const cases: [string, string][] = [
      ["src", "src/components/Palette.tsx"],
      ["PAL", "src/components/Palette.tsx"],
      ["pltsx", "Palette.tsx"],
      ["zzz", "Palette.tsx"],
      ["", "anything"],
    ];
    for (const [needle, hay] of cases) {
      expect(fuzzyLower(needle.toLowerCase(), hay.toLowerCase())).toEqual(
        fuzzy(needle, hay),
      );
    }
  });

  it("still ranks an earlier, tighter run higher", () => {
    const a = fuzzyLower("pal", "palette.tsx");
    const b = fuzzyLower("pal", "src/p/a/l.tsx");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!).toBeLessThan(b!);
  });

  it("rejects a non-subsequence", () => {
    expect(fuzzyLower("zzz", "palette.tsx")).toBeNull();
  });
});

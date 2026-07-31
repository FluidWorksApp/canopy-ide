import { describe, it, expect } from "vitest";
import { fmtTokens } from "./format";

describe("fmtTokens", () => {
  it("scales past M into B and T instead of printing five-digit millions", () => {
    expect(fmtTokens(6_441_700_000)).toBe("6.44B");
    expect(fmtTokens(2_500_000_000_000)).toBe("2.50T");
  });

  it("keeps the smaller units", () => {
    expect(fmtTokens(940)).toBe("940");
    expect(fmtTokens(29_400)).toBe("29.4k");
    expect(fmtTokens(29_400_000)).toBe("29.4M");
  });

  it("switches unit exactly at each threshold", () => {
    expect(fmtTokens(999_999)).toBe("1000.0k");
    expect(fmtTokens(1e6)).toBe("1.0M");
    expect(fmtTokens(1e9)).toBe("1.00B");
    expect(fmtTokens(1e12)).toBe("1.00T");
  });

  it("drops the thousands decimal in compact (status tray) mode only", () => {
    expect(fmtTokens(109_400, true)).toBe("109k");
    expect(fmtTokens(29_400_000, true)).toBe("29.4M");
  });

  it("keeps negatives signed rather than formatting the minus into the number", () => {
    expect(fmtTokens(-1_500_000)).toBe("-1.5M");
  });
});

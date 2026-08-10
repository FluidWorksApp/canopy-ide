import { describe, expect, it } from "vitest";
import { terminalMinimumContrast } from "./terminalContrast";

describe("terminalMinimumContrast", () => {
  it("raises only Codex cells to the WCAG AA floor", () => {
    expect(terminalMinimumContrast("codex")).toBe(4.5);
    expect(terminalMinimumContrast("claude")).toBe(1);
    expect(terminalMinimumContrast("amp")).toBe(1);
    expect(terminalMinimumContrast(null)).toBe(1);
  });
});

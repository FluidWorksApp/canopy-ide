import { describe, expect, it } from "vitest";
import { positionOf } from "./lspPosition";
import { getCaret, setCaret, clearCaret, truncateSelection } from "./editorState";

describe("positionOf", () => {
  const source = ["const other = 1;", "function handleFoo() {", "  return handleFooBar;", "}"].join(
    "\n",
  );

  it("converts a 1-based line and column to LSP's 0-based position", () => {
    expect(positionOf(source, { line: 2, column: 10 })).toEqual({ line: 1, character: 9 });
  });

  it("defaults the column when only a line is given", () => {
    expect(positionOf(source, { line: 3 })).toEqual({ line: 2, character: 0 });
  });

  it("finds a symbol on a word boundary, not inside a longer name", () => {
    // handleFooBar appears later; the whole-word match must land on line 2.
    expect(positionOf(source, { symbol: "handleFoo" })).toEqual({ line: 1, character: 9 });
  });

  it("treats regex characters in a symbol literally", () => {
    expect(positionOf("a.b = 1;\nconst x = 2;", { symbol: "a.b" })).toEqual({
      line: 0,
      character: 0,
    });
  });

  it("says so when the symbol isn't there, rather than guessing a position", () => {
    expect(() => positionOf(source, { symbol: "missing" })).toThrow(/doesn't appear/);
  });
});

describe("editor caret store", () => {
  it("holds the latest caret and forgets a closed file's", () => {
    setCaret({ path: "/w/a.ts", line: 3, column: 2 });
    expect(getCaret()?.line).toBe(3);
    clearCaret("/w/other.ts");
    expect(getCaret()).not.toBeNull();
    clearCaret("/w/a.ts");
    expect(getCaret()).toBeNull();
  });

  it("caps a selection so a whole file can't ride along in the snapshot", () => {
    expect(truncateSelection("x".repeat(50))).toHaveLength(50);
    const capped = truncateSelection("x".repeat(5000));
    expect(capped.length).toBeLessThan(5000);
    expect(capped.endsWith("…")).toBe(true);
  });
});

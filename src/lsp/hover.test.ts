import { describe, expect, it } from "vitest";
import { flattenHover, MAX_HOVER_CHARS } from "./hover";

describe("flattenHover", () => {
  it("reads MarkupContent", () => {
    expect(flattenHover({ kind: "markdown", value: "```ts\nconst x: number\n```" })).toBe(
      "const x: number",
    );
  });

  it("reads a bare string", () => {
    expect(flattenHover("fn main()")).toBe("fn main()");
  });

  it("reads the {language, value} MarkedString", () => {
    expect(flattenHover({ language: "rust", value: "fn main()" })).toBe("fn main()");
  });

  it("joins an array of mixed MarkedStrings, signature before docs", () => {
    const out = flattenHover([
      { language: "typescript", value: "function handleFoo(): void" },
      "Handles the foo.",
    ]);
    expect(out).toBe("function handleFoo(): void\n\nHandles the foo.");
  });

  it("is empty for a server that had nothing to say", () => {
    expect(flattenHover(null)).toBe("");
    expect(flattenHover(undefined)).toBe("");
    expect(flattenHover([])).toBe("");
    expect(flattenHover({ kind: "markdown", value: "   " })).toBe("");
  });

  it("collapses the blank runs a stripped fence leaves behind", () => {
    expect(flattenHover("```rust\nfn a()\n```\n\n\n\ndocs")).toBe("fn a()\n\ndocs");
  });

  it("caps a well-documented symbol rather than spending the context on prose", () => {
    const out = flattenHover("x".repeat(MAX_HOVER_CHARS * 2));
    expect(out.length).toBe(MAX_HOVER_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});

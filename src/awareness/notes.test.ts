import { describe, expect, it } from "vitest";
import { buildDiff, buildNotePrompt, clampNote, hashText, validateNotes } from "./notes";

describe("buildDiff", () => {
  it("renders edits as -/+ hunks and skips no-op edits", () => {
    const diff = buildDiff([
      { path: "src/pricing.ts", tool: "Edit", old: "export function priceFor() {}", new: "export function quote() {}" },
      { path: "src/same.ts", old: "x", new: "x" },
    ]);
    expect(diff).toBe("--- src/pricing.ts (Edit)\n- export function priceFor() {}\n+ export function quote() {}");
  });
  it("caps the diff and says how many edits were dropped", () => {
    const big = "y".repeat(80);
    const diff = buildDiff(
      [1, 2, 3].map((i) => ({ path: `f${i}.ts`, old: null, new: big })),
      200,
    );
    expect(diff.length).toBeLessThan(260);
    expect(diff).toContain("more edit(s) not shown");
  });
});

describe("hashText", () => {
  it("is stable and distinguishes inputs", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});

describe("buildNotePrompt", () => {
  it("carries the ask, the diff and every target's task and overlap", () => {
    const prompt = buildNotePrompt({
      from: { name: "Ana's agent", cli: "cli-a" },
      prompt: "rename priceFor to quote",
      diff: "--- src/pricing.ts\n- priceFor\n+ quote",
      targets: [
        {
          name: "Ben's agent",
          task: "cart discounts",
          files: ["src/cart.ts"],
          overlap: [{ path: "src/cart.ts", why: "references", symbol: "quote" }],
        },
      ],
    });
    expect(prompt).toContain("rename priceFor to quote");
    expect(prompt).toContain("+ quote");
    expect(prompt).toContain("Agent 1: Ben's agent");
    expect(prompt).toContain("Task: cart discounts");
    expect(prompt).toContain("src/cart.ts (uses a changed symbol: quote)");
    expect(prompt).toContain('{"notes":[');
  });
});

describe("clampNote", () => {
  it("keeps at most two sentences", () => {
    expect(clampNote("One.  Two!\nThree? Four.")).toBe("One. Two!");
    expect(clampNote("No terminal punctuation")).toBe("No terminal punctuation");
  });
});

describe("validateNotes", () => {
  it("maps the batch reply onto targets by agent number", () => {
    const out = validateNotes(
      {
        notes: [
          { agent: 2, relevant: true, note: "Ana renamed priceFor to quote. Update cart.ts.", risk: "conflict" },
          { agent: 1, relevant: false, note: "", risk: "none" },
        ],
      },
      3,
    );
    expect(out).toEqual([
      { relevant: false, note: "", risk: "none" },
      { relevant: true, note: "Ana renamed priceFor to quote. Update cart.ts.", risk: "conflict" },
      null,
    ]);
  });
  it("drops malformed items, defaults an unknown risk to low, and rejects the wrong shape", () => {
    const out = validateNotes(
      {
        notes: [
          { agent: 9, relevant: true, note: "out of range", risk: "low" },
          { agent: 1, relevant: "yes", note: "x", risk: "low" },
          { agent: 2, relevant: true, note: "", risk: "low" },
          { agent: 3, relevant: true, note: "Heads up.", risk: "huge" },
        ],
      },
      3,
    );
    expect(out).toEqual([null, null, { relevant: true, note: "Heads up.", risk: "low" }]);
    expect(validateNotes("nope", 1)).toBeNull();
    expect(validateNotes({ verdicts: [] }, 2)).toBeNull();
  });
  it("accepts a bare verdict for a single target", () => {
    expect(validateNotes({ relevant: true, note: "Changed.", risk: "low" }, 1)).toEqual([
      { relevant: true, note: "Changed.", risk: "low" },
    ]);
  });
});

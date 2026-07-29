import { describe, expect, it } from "vitest";
import { MAX_CANON, SAFE_LINE_BYTES, byteLength, briefPointer, fitsOnOneLine } from "./agentSeed";

describe("byteLength", () => {
  it("counts bytes, not characters", () => {
    // The distinction that made the original bug invisible to a length check:
    // an em-dash is one character and three bytes.
    expect("—".length).toBe(1);
    expect(byteLength("—")).toBe(3);
  });
});

describe("fitsOnOneLine", () => {
  it("passes an ordinary command", () => {
    expect(fitsOnOneLine("claude 'fix the failing test in src/foo.ts'")).toBe(true);
  });

  it("stays under what a canonical-mode tty will hold", () => {
    expect(SAFE_LINE_BYTES).toBeLessThan(MAX_CANON);
  });

  it("rejects the brief that was silently truncated", () => {
    // The real one, rebuilt: four screenshots with their paths, the serving
    // component, and a note each. It reached 1024 bytes inside the fourth path
    // and the shell was left at a `quote>` prompt.
    const shot = (n: number) =>
      `(${n}) /Users/shoaib/Documents/GitHub/coraa-app/coraa-agent/.canopy/spot/ctx-178529325${n}.png, ` +
      `a region of the page at http://localhost:3000/ — a note about what to change here`;
    const brief =
      `I took 4 screenshots of this project's running page at http://localhost:3000/. ` +
      `The page is served by the "website" run (\`pnpm run dev\`) working in the "coraa-ai" ` +
      `component, \`/Users/shoaib/Documents/GitHub/coraa-ai\` — that is the codebase to change. ` +
      `Read the image file(s) — they are PNGs on disk — then do what each note asks: ` +
      `${[1, 2, 3, 4].map(shot).join(" ")}`;
    expect(byteLength(brief)).toBeGreaterThan(MAX_CANON);
    expect(fitsOnOneLine(`claude '${brief}'`)).toBe(false);
  });

  it("counts the carriage return that is written after it", () => {
    // A line of exactly the budget still has a CR to follow, so it does not fit.
    expect(fitsOnOneLine("x".repeat(SAFE_LINE_BYTES))).toBe(false);
    expect(fitsOnOneLine("x".repeat(SAFE_LINE_BYTES - 1))).toBe(true);
  });

  it("is not fooled by multi-byte characters near the boundary", () => {
    // 300 em-dashes is 300 characters and 900 bytes.
    const dashes = "—".repeat(300);
    expect(dashes.length).toBeLessThan(SAFE_LINE_BYTES);
    expect(fitsOnOneLine(dashes)).toBe(false);
  });
});

describe("briefPointer", () => {
  it("names the file and is short enough to type", () => {
    const line = `claude '${briefPointer("/Users/x/p/.canopy/spot/brief-1785293237.md")}'`;
    expect(line).toContain("/Users/x/p/.canopy/spot/brief-1785293237.md");
    expect(fitsOnOneLine(line)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { generatePrDraft, generatePrDraftRefined, type PrDraftInput } from "./prGenerate";

const base: PrDraftInput = {
  branch: "feat/remote-search",
  commits: ["feat(search): add remote search filters.", "fix: keep the cursor in place"],
  files: ["src/search.ts", "src/search.test.ts", "crates/core/src/lib.rs", "README.md"],
  stat: "4 files changed, 40 insertions(+), 2 deletions(-)",
  template: null,
};

describe("generatePrDraft", () => {
  it("titles a single commit from its subject, without type prefix or period", () => {
    const { title } = generatePrDraft({ ...base, commits: ["fix(pty): stop dropping output."] });
    expect(title).toBe("Stop dropping output");
  });

  it("falls back to the branch name for several commits", () => {
    expect(generatePrDraft(base).title).toBe("Remote search");
  });

  it("uses the first commit when the branch says nothing", () => {
    const { title } = generatePrDraft({ ...base, branch: "main-2", commits: ["add a", "add b"] });
    expect(title).toBe("Add a");
  });

  it("prefers the ticket title and links a numbered ticket", () => {
    const d = generatePrDraft({
      ...base,
      ticket: { id: "#42", title: "search is slow", url: "https://x/42" },
    });
    expect(d.title).toBe("Search is slow");
    expect(d.body).toContain("Closes #42");
  });

  it("links a non-numeric ticket by url", () => {
    const d = generatePrDraft({
      ...base,
      ticket: { id: "ENG-7", title: "t", url: "https://linear.app/x/ENG-7" },
    });
    expect(d.body).toContain("Ticket: ENG-7 (https://linear.app/x/ENG-7)");
  });

  it("writes summary, grouped changes and a testing placeholder", () => {
    const { body } = generatePrDraft(base);
    expect(body).toMatch(/## Summary\n[\s\S]*add remote search filters/);
    expect(body).toContain("## Changes");
    expect(body).toContain("- `src`: 2 files");
    expect(body).toContain("- `crates/core`: 1 file");
    expect(body).toContain("- `Repository root`: 1 file");
    expect(body).toContain("## Testing");
    expect(body).toContain("4 files changed");
  });

  it("fills the matching sections of a PR template and keeps the rest", () => {
    const template = [
      "## Description",
      "<!-- what does this do -->",
      "",
      "## Type of change",
      "- [ ] Bug fix",
      "",
      "## How was this tested?",
      "<!-- steps -->",
    ].join("\n");
    const { body } = generatePrDraft({ ...base, template });
    expect(body).toContain("## Description\n- add remote search filters\n- keep the cursor in place");
    expect(body).not.toContain("<!-- what does this do -->");
    expect(body).toContain("## Type of change\n- [ ] Bug fix");
    expect(body).toMatch(/## How was this tested\?\n[^#]*Describe how this was verified/);
    expect(body).not.toContain("## Changes");
  });

  it("keeps an unrecognised template whole and puts the summary above it", () => {
    const { body } = generatePrDraft({ ...base, template: "## Checklist\n- [ ] done" });
    expect(body.indexOf("## Summary")).toBeLessThan(body.indexOf("## Checklist"));
    expect(body).toContain("- [ ] done");
  });

  it("works with no commits at all", () => {
    const d = generatePrDraft({ ...base, commits: [], files: [], stat: "" });
    expect(d.title).toBe("Remote search");
    expect(d.body).toContain("## Summary");
  });
});

describe("generatePrDraftRefined", () => {
  it("returns the refiner's draft when it succeeds", async () => {
    const d = await generatePrDraftRefined(base, async () => ({ title: "T", body: "B" }));
    expect(d).toEqual({ title: "T", body: "B" });
  });

  it("falls back to the heuristic draft offline or on failure", async () => {
    const heuristic = generatePrDraft(base);
    expect(await generatePrDraftRefined(base, async () => Promise.reject(new Error("x")))).toEqual(
      heuristic,
    );
    expect(await generatePrDraftRefined(base, null)).toEqual(heuristic);
    expect(await generatePrDraftRefined(base, async () => ({ title: " ", body: "" }))).toEqual(
      heuristic,
    );
  });
});

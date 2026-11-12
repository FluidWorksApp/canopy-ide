import { describe, expect, it, vi } from "vitest";
import { buildDraftPrompt, draftPrWithBrain, validateDraft, type DraftDeps } from "./prDraftBrain";

const good = { title: "Keep scrcpy alive", commit: "Keep scrcpy alive\n\nWhy.", body: "## Summary\nx" };

function deps(over: Partial<DraftDeps> = {}): DraftDeps {
  return {
    status: async () => ({
      branch: "feat/x",
      entries: [
        { status: " M", path: "src/a.ts" },
        { status: "??", path: "src/new.ts" },
        { status: " M", path: ".env" },
      ],
    }),
    diff: async (_r, path) => `diff of ${path}`,
    readText: async (path) => `contents of ${path}`,
    context: async () => ({ branch: "feat/x", base: "main", commits: ["c1"], stat: "2 files", template: null }),
    ask: vi.fn(async (req) => ({ ok: true as const, text: "", value: req.validate!(good) as never, costUsd: null, inputTokens: null, outputTokens: null, durationMs: 1, model: null })),
    ...over,
  };
}

describe("draftPrWithBrain", () => {
  it("drafts from diffs and new files, and leaves secret-looking paths out", async () => {
    const d = deps();
    const out = await draftPrWithBrain({ repo: "/r" }, d);
    expect(out).toEqual({ title: good.title, message: good.commit, body: good.body });
    const prompt = vi.mocked(d.ask).mock.calls[0][0].prompt;
    expect(prompt).toContain("diff of src/a.ts");
    expect(prompt).toContain("contents of /r/src/new.ts");
    expect(prompt).not.toContain(".env");
  });

  it("does not ask when there is nothing to describe", async () => {
    const d = deps({
      status: async () => ({ branch: "b", entries: [] }),
      context: async () => ({ branch: "b", base: "main", commits: [], stat: "", template: null }),
    });
    expect(await draftPrWithBrain({ repo: "/r" }, d)).toBeNull();
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("returns null when the brain fails or throws", async () => {
    const failed = deps({ ask: async () => ({ ok: false, reason: "no-brain", message: "" }) });
    expect(await draftPrWithBrain({ repo: "/r" }, failed)).toBeNull();
    const threw = deps({ ask: async () => { throw new Error("boom"); } });
    expect(await draftPrWithBrain({ repo: "/r" }, threw)).toBeNull();
  });

  it("still drafts from the branch's commits when the context is all there is", async () => {
    const d = deps({ status: async () => ({ branch: "b", entries: [] }) });
    expect(await draftPrWithBrain({ repo: "/r" }, d)).not.toBeNull();
  });
});

describe("validateDraft", () => {
  it("accepts commit or message and flattens the title", () => {
    expect(validateDraft({ title: " A\n b ", message: "m", body: "b" })).toEqual({ title: "A b", message: "m", body: "b" });
    expect(validateDraft(good)?.message).toBe(good.commit);
  });
  it("rejects a missing or oversized part", () => {
    expect(validateDraft(null)).toBeNull();
    expect(validateDraft({ ...good, body: "" })).toBeNull();
    expect(validateDraft({ ...good, commit: "" })).toBeNull();
    expect(validateDraft({ ...good, title: "x".repeat(121) })).toBeNull();
  });
});

describe("buildDraftPrompt", () => {
  it("uses the repo template when there is one and says so otherwise", () => {
    const base = { branch: "b", base: "main", commits: [], stat: "", shown: [], unshown: [] };
    expect(buildDraftPrompt({ ...base, template: "## What" })).toContain("Pull request template:\n## What");
    expect(buildDraftPrompt({ ...base, template: null })).toContain("Summary, Changes and Testing");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./brainCall", () => ({ askBrain: vi.fn() }));
vi.mock("./ipc", () => ({
  gitDiff: vi.fn(async (_repo: string, path: string) => `diff --git a/${path} b/${path}\n+change in ${path}\n`),
  gitLog: vi.fn(async () => [{ subject: "Fix the tab strip overflow" }, { subject: "Add brain chip" }]),
}));

import { askBrain } from "./brainCall";
import {
  buildCommitPrompt,
  cleanCommitMessage,
  COMMIT_SUBJECT_MAX,
  stagedDiff,
  suggestCommitMessage,
  suggestFailure,
} from "./brainCommitMessage";

const askMock = askBrain as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  askMock.mockReset();
});

describe("staged diff", () => {
  it("joins staged patches and names the ones over budget", async () => {
    const read = async (_r: string, p: string) => (p === "big" ? "x".repeat(500) : `+${p}\n`);
    const out = await stagedDiff("/r", ["a", "big", "b"], 100, read);
    expect(out.diff).toBe("+a\n+b\n");
    expect(out.omitted).toEqual(["big"]);
  });
});

describe("commit prompt", () => {
  it("carries the diff, the files, house style and the rules", () => {
    const prompt = buildCommitPrompt({
      diff: "+hello\n",
      files: ["src/a.ts"],
      omitted: ["package-lock.json"],
      recentSubjects: ["Fix the thing"],
    });
    expect(prompt).toContain("```diff\n+hello\n```");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("package-lock.json");
    expect(prompt).toContain("- Fix the thing");
    expect(prompt).toContain(`at most ${COMMIT_SUBJECT_MAX} characters`);
    expect(prompt).toMatch(/commit message only/);
  });
});

describe("cleaning the reply", () => {
  it("keeps a subject and body", () => {
    expect(cleanCommitMessage("Add brain chip\n\nShows spend by feature.")).toBe(
      "Add brain chip\n\nShows spend by feature.",
    );
  });

  it("strips fences, labels, quotes and a trailing period", () => {
    expect(cleanCommitMessage("```\nAdd brain chip.\n```")).toBe("Add brain chip");
    expect(cleanCommitMessage("Commit message: Add brain chip")).toBe("Add brain chip");
    expect(cleanCommitMessage('"Add brain chip"')).toBe("Add brain chip");
  });

  it("cuts a long subject at a word and rejects non-answers", () => {
    const long = `Add ${"very ".repeat(20)}long subject`;
    const cut = cleanCommitMessage(long)!;
    expect(cut.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX);
    expect(long.startsWith(cut)).toBe(true);
    expect(cleanCommitMessage("")).toBeNull();
    expect(cleanCommitMessage("Sorry, I can't see a diff")).toBeNull();
    expect(cleanCommitMessage(42)).toBeNull();
  });
});

describe("suggestCommitMessage", () => {
  it("asks the brain on the main tier, metered as commit-message", async () => {
    askMock.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "Add the brain chip",
      value: req.validate("Add the brain chip."),
      costUsd: 0.01,
    }));
    const out = await suggestCommitMessage("/repo", ["src/a.ts"]);
    expect(out).toEqual({ ok: true, message: "Add the brain chip" });
    const req = askMock.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "commit-message", tier: "main", cwd: "/repo" });
    expect(req.prompt).toContain("+change in src/a.ts");
    expect(req.prompt).toContain("Fix the tab strip overflow");
  });

  it("passes brain failures through with a plain explanation", async () => {
    askMock.mockResolvedValue({ ok: false, reason: "over-budget", message: "x" });
    const out = await suggestCommitMessage("/repo", ["src/a.ts"]);
    expect(out).toMatchObject({ ok: false, reason: "over-budget" });
    if (!out.ok) expect(suggestFailure(out)).toMatch(/budget/);
  });
});

import { describe, expect, it } from "vitest";
import { actionRows, sessionRows, tabRows, type SpotContext } from "./spotSources";
import type { SubTab } from "./components/ProjectView/helpers";

const term = (id: string, title: string, ptyId: number): SubTab => ({
  id,
  type: "terminal",
  cwd: "/repo",
  title,
  ptyId,
});

const ctx = (over: Partial<SpotContext> = {}): SpotContext => ({
  components: [{ label: "app", path: "/repo" }],
  tabs: [term("t1", "dev server", 1), term("t2", "tests", 2)],
  serverGroups: [],
  digests: [],
  projectId: "p1",
  clis: [{ id: "claude", name: "Claude Code" }],
  installed: { claude: true },
  ...over,
});

describe("actionRows", () => {
  it("pins the run-task row first on any non-empty query", () => {
    const rows = actionRows("fix the flaky test", ctx());
    expect(rows[0].action).toEqual({
      type: "run-task",
      brief: "fix the flaky test",
    });
    // Pinned by score, so no launcher match can rank above it.
    expect(Math.min(...rows.map((r) => r.score))).toBe(rows[0].score);
  });

  it("offers no run-task row with nothing typed", () => {
    const rows = actionRows("", ctx());
    expect(rows.some((r) => r.action.type === "run-task")).toBe(false);
    expect(rows.some((r) => r.action.type === "new-shell")).toBe(true);
  });

  it("folds the launcher entries in and filters them", () => {
    const rows = actionRows("claude", ctx());
    expect(
      rows.some(
        (r) => r.action.type === "launch-cli" && r.action.cliId === "claude",
      ),
    ).toBe(true);
    expect(rows.some((r) => r.action.type === "new-preview")).toBe(false);
  });
});

describe("tabRows", () => {
  it("matches open tabs by their display label", () => {
    const rows = tabRows("dev", ctx());
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toEqual({ type: "focus-tab", tabId: "t1" });
  });
});

describe("sessionRows", () => {
  it("finds a session by what was said in it, and drops micro-task runs", () => {
    const digests = [
      {
        session_id: "s1",
        agent: "claude",
        branch: "feat/x",
        prompts: ["refactor the relay handshake"],
      },
      {
        session_id: "s2",
        agent: "claude",
        prompts: ["refactor the relay handshake"],
        micro: true,
      },
    ];
    const rows = sessionRows("relay handshake", ctx({ digests }));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toMatchObject({
      type: "open-session",
      digest: { session_id: "s1" },
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { AgentEdit, SessionDigest } from "../ipc";
import { getSettings, updateSettings } from "../settings";
import { commitMessageWithSessions, sessionsInCommit, withSessionTrailers, type TrailerDeps } from "./trailers";

describe("withSessionTrailers", () => {
  it("adds a trailer block after the message", () => {
    expect(withSessionTrailers("Fix login", [{ agent: "a", sessionId: "s1" }])).toBe("Fix login\n\nAgent-Session: a/s1\n");
  });
  it("joins an existing trailer block and never repeats a session", () => {
    const msg = "Fix login\n\nBody text.\n\nCo-Authored-By: X <x@y>";
    expect(withSessionTrailers(msg, [{ agent: "a", sessionId: "s1" }, { agent: "a", sessionId: "s1" }])).toBe(
      "Fix login\n\nBody text.\n\nCo-Authored-By: X <x@y>\nAgent-Session: a/s1\n",
    );
    const already = "Fix\n\nAgent-Session: a/s1\n";
    expect(withSessionTrailers(already, [{ agent: "a", sessionId: "s1" }])).toBe(already);
  });
  it("leaves a message alone with no sessions", () => {
    expect(withSessionTrailers("Fix", [])).toBe("Fix");
  });
});

const NOW = 1_760_000_000_000;
const d = (id: string, over: Partial<SessionDigest> = {}): SessionDigest => ({
  session_id: id,
  agent: "a",
  cwd: "/repo",
  updated: NOW / 1000 - 60,
  ...over,
});
const e = (path: string, present: boolean): AgentEdit => ({ ts: 1, path, tool: "Edit", old: null, new: "x", present });

const deps = (journals: Record<string, AgentEdit[]>, digests: SessionDigest[]): TrailerDeps => ({
  staged: async () => ["src/a.ts", "src/b.ts"],
  digests: async () => digests,
  edits: async (_repo, sid) => journals[sid] ?? [],
  now: () => NOW,
});

describe("sessionsInCommit", () => {
  it("names only sessions whose surviving edits are staged, in this repo, recently", async () => {
    const found = await sessionsInCommit(
      "/repo",
      deps(
        {
          wrote: [e("src/a.ts", true)],
          overwritten: [e("src/b.ts", false)],
          elsewhere: [e("src/a.ts", true)],
          stale: [e("src/a.ts", true)],
          unstaged: [e("src/c.ts", true)],
        },
        [
          d("wrote"),
          d("overwritten"),
          d("elsewhere", { cwd: "/other" }),
          d("stale", { updated: NOW / 1000 - 30 * 86_400 }),
          d("unstaged", { cwd: "/repo/sub" }),
        ],
      ),
    );
    expect(found).toEqual([{ agent: "a", sessionId: "wrote" }]);
  });

  it("reads every candidate's journal at once, keeping newest-first order", async () => {
    // Each read waits until all of them have started: sequential reads would
    // never get past the first.
    let started = 0;
    const gate: { open?: () => void } = {};
    const allStarted = new Promise<void>((r) => (gate.open = r));
    const slow: TrailerDeps = {
      ...deps({}, [d("old", { updated: NOW / 1000 - 600 }), d("new"), d("none")]),
      edits: async (_repo, sid) => {
        if (++started === 3) gate.open!();
        await allStarted;
        if (sid === "none") throw new Error("journal unreadable");
        return [e("src/a.ts", true)];
      },
    };
    expect(await sessionsInCommit("/repo", slow)).toEqual([
      { agent: "a", sessionId: "new" },
      { agent: "a", sessionId: "old" },
    ]);
  });
});

describe("commitMessageWithSessions", () => {
  const before = getSettings().commitSessionTrailers;
  afterEach(() => updateSettings({ commitSessionTrailers: before }));

  it("is off by default and never fails a commit", async () => {
    expect(getSettings().commitSessionTrailers).toBe(false);
    const d1 = deps({ s: [e("src/a.ts", true)] }, [d("s")]);
    expect(await commitMessageWithSessions("/repo", "Fix", d1)).toBe("Fix");
    updateSettings({ commitSessionTrailers: true });
    expect(await commitMessageWithSessions("/repo", "Fix", d1)).toBe("Fix\n\nAgent-Session: a/s\n");
    const broken: TrailerDeps = { ...d1, staged: async () => Promise.reject(new Error("no git")) };
    expect(await commitMessageWithSessions("/repo", "Fix", broken)).toBe("Fix");
  });
});

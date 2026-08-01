import { describe, expect, it } from "vitest";
import { isReachable, resolveAgentForPr, type ResolveContext } from "./agentForPr";
import type { ProvenanceEdge } from "./ipc";

const edge = (over: Partial<ProvenanceEdge> = {}): ProvenanceEdge => ({
  repo: "/repo",
  pr_number: 42,
  pr_url: "https://github.com/o/n/pull/42",
  branch: "feat/x",
  session_id: "s1",
  agent: "claude",
  profile: "default",
  cwd: "/repo/wt",
  via: "job_done",
  at: 1_700_000_000,
  confidence: "declared",
  ...over,
});

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  live: new Map(),
  dirExists: () => true,
  resumeWith: (_agent, id) => `claude --resume ${id}`,
  ...over,
});

describe("who to send a PR change request to", () => {
  it("prefers a session that is up, over a newer one that is not", () => {
    // The rule that makes the ladder useful. Recency is the tiebreak, not the
    // rule: a running agent already holding this PR's context beats a newer
    // conversation that has exited.
    const newer = edge({ session_id: "new", at: 2_000_000_000 });
    const older = edge({ session_id: "old", at: 1_000_000_000 });
    const got = resolveAgentForPr([newer, older], ctx({ live: new Map([["old", 7]]) }));
    expect(got.kind).toBe("live");
    expect(got.sessionId).toBe("old");
    expect(got.ptyId).toBe(7);
    expect(isReachable(got)).toBe(true);
  });

  it("when none is live, the newest wins", () => {
    const newer = edge({ session_id: "new", at: 2_000_000_000 });
    const older = edge({ session_id: "old", at: 1_000_000_000 });
    const got = resolveAgentForPr([newer, older], ctx());
    expect(got.kind).toBe("resumable");
    expect(got.sessionId).toBe("new");
    expect(got.resumeCommand).toBe("claude --resume new");
  });

  // A session in another window has a digest but no terminal this window can
  // reach. It must not be reported live (there is nothing to type into) and
  // must not be resumed (it is running — a second process on one conversation
  // id is how you corrupt it).
  it("says so when the session belongs to another window", () => {
    const got = resolveAgentForPr(
      [edge({ session_id: "s1" })],
      ctx({ live: new Map([["s1", null]]) }),
    );
    expect(got.kind).toBe("elsewhere");
    expect(got.ptyId).toBeUndefined();
    expect(isReachable(got)).toBe(false);
    expect(got.why).toMatch(/another Canopy window/);
  });

  it("falls to cold when the directory it worked in is gone", () => {
    const got = resolveAgentForPr([edge()], ctx({ dirExists: () => false }));
    expect(got.kind).toBe("cold");
    // Still carries the edge: a new session should be told what it is picking up.
    expect(got.sessionId).toBe("s1");
    expect(got.why).toMatch(/directory it worked in is gone/);
  });

  it("falls to cold when the CLI cannot reopen a conversation", () => {
    // gemini resumes by list index, aider only per directory — restoreCommand
    // returns null for both, and offering Resume would be a button that drops
    // the user into a CLI error.
    const got = resolveAgentForPr(
      [edge({ agent: "gemini" })],
      ctx({ resumeWith: () => null }),
    );
    expect(got.kind).toBe("cold");
    expect(got.why).toMatch(/gemini cannot reopen/);
  });

  it("skips an unresumable edge for one that is resumable", () => {
    const bad = edge({ session_id: "bad", cwd: "/gone", at: 2_000_000_000 });
    const good = edge({ session_id: "good", cwd: "/repo/wt", at: 1_000_000_000 });
    const got = resolveAgentForPr(
      [bad, good],
      ctx({ dirExists: (d) => d === "/repo/wt" }),
    );
    expect(got.kind).toBe("resumable");
    expect(got.sessionId).toBe("good");
  });

  it("carries the profile, because a resume without it looks in the wrong store", () => {
    const got = resolveAgentForPr([edge({ profile: "work" })], ctx());
    expect(got.profile).toBe("work");
  });

  it("is honest when nothing was ever recorded", () => {
    const got = resolveAgentForPr([], ctx());
    expect(got.kind).toBe("cold");
    expect(got.edge).toBeUndefined();
    expect(got.sessionId).toBeUndefined();
    expect(got.why).toMatch(/no session was ever recorded/);
  });
});

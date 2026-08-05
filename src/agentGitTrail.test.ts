import { describe, expect, it } from "vitest";
import { agentGitTrail, type TrailFacts } from "./agentGitTrail";

const facts = (over: Partial<TrailFacts> = {}): TrailFacts => ({
  dirty: 0,
  commits: 0,
  unpushed: null,
  onBase: false,
  merged: false,
  isolated: true,
  touched: 0,
  prNumber: null,
  raised: [],
  ...over,
});

const states = (f: TrailFacts) => agentGitTrail(f).map((s) => s.state);
const step = (f: TrailFacts, id: string) =>
  agentGitTrail(f).find((s) => s.id === id)!;

describe("the road out of the checkout", () => {
  it("a fresh session has done nothing yet", () => {
    expect(states(facts())).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("uncommitted work is the thing to flag, not just note", () => {
    const f = facts({ dirty: 3 });
    expect(step(f, "code").state).toBe("done");
    expect(step(f, "commit").state).toBe("attention");
    expect(step(f, "commit").detail).toContain("3 uncommitted files");
  });

  it("commits with a clean tree read as committed", () => {
    const f = facts({ commits: 2 });
    expect(step(f, "commit").state).toBe("done");
    expect(step(f, "commit").detail).toContain("2 commits");
  });

  it("dirty beside commits still demands attention", () => {
    const f = facts({ dirty: 1, commits: 2 });
    expect(step(f, "commit").state).toBe("attention");
    expect(step(f, "commit").detail).toContain("beside 2 commits");
  });

  it("a branch never pushed is at risk, one fully pushed is done", () => {
    expect(step(facts({ commits: 2, unpushed: null }), "push").state).toBe(
      "attention",
    );
    expect(step(facts({ commits: 2, unpushed: null }), "push").detail).toBe(
      "the branch was never pushed",
    );
    expect(step(facts({ commits: 2, unpushed: 0 }), "push").state).toBe("done");
    expect(step(facts({ commits: 2, unpushed: 1 }), "push").state).toBe(
      "attention",
    );
  });

  it("nothing committed means nothing to push — pending, not at risk", () => {
    expect(step(facts({ dirty: 2 }), "push").state).toBe("pending");
  });

  it("an open PR names itself on the step", () => {
    const f = facts({ commits: 2, unpushed: 0, prNumber: 441 });
    const pr = step(f, "pr");
    expect(pr.state).toBe("done");
    expect(pr.label).toBe("PR #441");
  });

  it("a raised-then-merged PR still counts via provenance", () => {
    const f = facts({ merged: true, raised: [430, 438] });
    const pr = step(f, "pr");
    expect(pr.state).toBe("done");
    expect(pr.label).toBe("PR #438");
    expect(pr.detail).toContain("raised by this session");
  });

  it("merged work is pushed and landed even with no live PR", () => {
    const f = facts({ commits: 2, merged: true });
    expect(step(f, "push").state).toBe("done");
    expect(step(f, "pr").state).toBe("done");
  });

  it("on the base branch, a clean tree after edits reads done with the caveat", () => {
    const f = facts({ onBase: true, touched: 4 });
    expect(step(f, "commit").state).toBe("done");
    expect(step(f, "commit").detail).toContain("base branch");
  });

  it("a shared checkout says its dirty count may not be this agent's", () => {
    const f = facts({ dirty: 2, isolated: false });
    expect(step(f, "commit").detail).toContain("shared checkout");
  });
});

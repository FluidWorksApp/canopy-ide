// The two axes, and the rule that keeps them apart.
import { describe, expect, it } from "vitest";
import { bucketFor, declaredQuiet, dotFor, isRunning, rankSessions, reclaimable, ringFor } from "./compose";
import { reduceAttention } from "./attention";
import { LIFE_STATES, NO_ATTENTION, type Attention, type Life, type LifeState } from "./vocabulary";

const NOW = 1_800_000_000;

const life = (state: LifeState, over: Partial<Life> = {}): Life => ({
  state,
  confidence: "proven",
  via: "turn-boundary",
  since: NOW,
  note: "",
  agent: "claude",
  ...over,
});

const unseen: Attention = { kind: "unseen", since: NOW, why: "went-quiet" };
const blocked: Attention = { kind: "blocked", since: NOW, why: "permission" };

describe("bucketFor — the composition, exhaustively", () => {
  it("covers all 18 combinations without a gap", () => {
    const kinds: Attention[] = [NO_ATTENTION, unseen, blocked];
    for (const s of LIFE_STATES) {
      for (const a of kinds) {
        expect(["attention", "active", "quiet"]).toContain(bucketFor(life(s), a));
      }
    }
  });

  // The bug this module was written for.
  it("SYMPTOM A: a working agent with an unread ring is Working, not Needs you", () => {
    expect(bucketFor(life("working"), unseen)).toBe("active");
  });

  it("SYMPTOM B: an ended agent with an unread ring is Idle, not Needs you", () => {
    expect(bucketFor(life("ended"), unseen)).toBe("quiet");
  });

  it("an agent we have lost track of is Idle, not Needs you", () => {
    expect(bucketFor(life("unknown", { confidence: "inferred", via: "none", reason: "went-quiet" }), unseen)).toBe("quiet");
  });

  it("never puts a session in Needs you on unseen activity alone", () => {
    for (const s of LIFE_STATES) {
      if (s === "waiting") continue;
      expect(bucketFor(life(s), unseen), `${s} + unseen`).not.toBe("attention");
    }
  });

  it("still promotes a live block", () => {
    expect(bucketFor(life("waiting"), NO_ATTENTION)).toBe("attention");
    expect(bucketFor(life("idle"), blocked)).toBe("attention");
  });

  it("lets live working outrank a block the digest has not caught up with", () => {
    expect(
      bucketFor(life("working"), blocked),
      "do not reorder these to make the card appear sooner — that is the bug",
    ).toBe("active");
  });

  it("keeps the ring additive and bucket-free", () => {
    expect(ringFor(unseen)).toBe(true);
    expect(ringFor(blocked)).toBe(false);
    expect(ringFor(NO_ATTENTION)).toBe(false);
  });

  it("shows the lifecycle on the dot, whatever the ring says", () => {
    expect(dotFor(life("working"))).toBe("working");
    expect(dotFor(life("unknown"))).toBe("unknown");
  });
});

describe("focus cannot move a lifecycle", () => {
  it("clears an unread ring and nothing else", () => {
    expect(reduceAttention(unseen, { t: "focus", at: NOW, visible: true }, "claude")).toEqual(NO_ATTENTION);
  });

  it("cannot answer a question by glancing at it", () => {
    expect(reduceAttention(blocked, { t: "focus", at: NOW, visible: true }, "claude")).toEqual(blocked);
  });

  it("does nothing while the tab is hidden", () => {
    expect(reduceAttention(unseen, { t: "focus", at: NOW, visible: false }, "claude")).toEqual(unseen);
  });
});

describe("the agent retracts its own ring", () => {
  it("clears a went-quiet ring once the agent is working again", () => {
    const next = reduceAttention(unseen, { t: "life", at: NOW, next: life("working") }, "claude");
    expect(next.kind, "the agent disproved the guess; the ring should not need a click").toBe("none");
  });

  it("clears both flags when the agent moves", () => {
    expect(reduceAttention(blocked, { t: "hook", at: NOW, signal: "turn-start" }, "claude").kind).toBe("none");
    expect(reduceAttention(unseen, { t: "hook", at: NOW, signal: "turn-progress" }, "claude").kind).toBe("none");
  });

  it("keeps an outstanding question when we lose track of the agent", () => {
    const next = reduceAttention(blocked, { t: "life", at: NOW, next: life("unknown", { confidence: "inferred" }) }, "claude");
    expect(next.kind, "losing sight of an agent is not evidence its question went away").toBe("blocked");
  });

  it("clears everything when the session ends", () => {
    expect(
      reduceAttention(blocked, { t: "life", at: NOW, next: life("ended") }, "claude").kind,
    ).toBe("none");
  });
});

describe("the went-quiet heuristic only runs where it is needed", () => {
  it("is off for a CLI that can say it is blocked", () => {
    for (const cli of ["claude", "codex", "opencode", "omp"]) {
      expect(
        reduceAttention(NO_ATTENTION, { t: "quiet", at: NOW }, cli).kind,
        `${cli} has a way to tell us — guessing alongside it only produces disagreement`,
      ).toBe("none");
    }
  });

  it("is on for a CLI that cannot", () => {
    for (const cli of ["agy", "aider", "amp"]) {
      expect(reduceAttention(NO_ATTENTION, { t: "quiet", at: NOW }, cli).kind).toBe("unseen");
    }
  });

  it("never overwrites a real block with a guess", () => {
    expect(reduceAttention(blocked, { t: "quiet", at: NOW }, "amp")).toEqual(blocked);
  });
});

describe("reclaimable — the destruction gate", () => {
  it("allows only a proven finish", () => {
    expect(reclaimable(life("idle"), NO_ATTENTION)).toBe(true);
    expect(reclaimable(life("ended", { via: "session-end" }), NO_ATTENTION)).toBe(true);
  });

  it("refuses everything we merely believe", () => {
    expect(reclaimable(life("idle", { confidence: "reported" }), NO_ATTENTION)).toBe(false);
    expect(reclaimable(life("idle", { confidence: "inferred" }), NO_ATTENTION)).toBe(false);
  });

  it("refuses a session with an outstanding question", () => {
    expect(reclaimable(life("idle"), blocked)).toBe(false);
  });

  it("refuses every non-finished state", () => {
    for (const s of LIFE_STATES) {
      if (s === "idle" || s === "ended") continue;
      expect(reclaimable(life(s), NO_ATTENTION), s).toBe(false);
    }
  });

  it("does not count an unread ring as a reason to keep a finished session", () => {
    expect(reclaimable(life("idle"), unseen)).toBe(true);
  });
});

describe("declaredQuiet — the strip's fast fall", () => {
  it("passes a reported turn end — the needsTrust CLI's own declaration", () => {
    // The screenshot bug: codex's Stop arrived, the dot read idle, and the
    // active tab still could not leave Working because codex never grades
    // "proven". The declaration is what matters, not the grade.
    expect(declaredQuiet(life("idle", { confidence: "reported", via: "turn-boundary" }))).toBe(true);
    expect(declaredQuiet(life("ended", { confidence: "reported", via: "session-end" }))).toBe(true);
  });

  it("passes every proven finish, whatever the rung", () => {
    expect(declaredQuiet(life("ended", { via: "process-gone" }))).toBe(true);
    expect(declaredQuiet(life("idle"))).toBe(true);
  });

  it("refuses a quiet we merely inferred", () => {
    expect(declaredQuiet(life("idle", { confidence: "inferred", via: "cpu" }))).toBe(false);
    expect(declaredQuiet(life("unknown", { confidence: "inferred", via: "none" }))).toBe(false);
  });

  it("refuses every non-finished state", () => {
    for (const s of LIFE_STATES) {
      if (s === "idle" || s === "ended") continue;
      expect(declaredQuiet(life(s)), s).toBe(false);
    }
  });
});

describe("isRunning", () => {
  it("excludes unknown, because we can promise neither way", () => {
    expect(isRunning(life("unknown", { confidence: "inferred" }))).toBe(false);
    expect(isRunning(life("working"))).toBe(true);
    expect(isRunning(life("waiting"))).toBe(true);
    expect(isRunning(life("idle"))).toBe(false);
  });
});

describe("rankSessions — one comparator", () => {
  it("puts what needs you above what is working", () => {
    const rows = [
      { life: life("working"), attention: NO_ATTENTION, updated: 10 },
      { life: life("waiting"), attention: NO_ATTENTION, updated: 5 },
    ];
    const [first] = [...rows].sort(rankSessions);
    expect(first.life.state, "the rail's old comparator ranked working above waiting, hiding a blocked agent behind a crashed one").toBe("waiting");
  });

  it("breaks ties by recency", () => {
    const rows = [
      { life: life("idle"), attention: NO_ATTENTION, updated: 5 },
      { life: life("idle"), attention: NO_ATTENTION, updated: 50 },
    ];
    expect([...rows].sort(rankSessions)[0].updated).toBe(50);
  });
});

import { describe, expect, it } from "vitest";
import { signalFor } from "./agentLifeStore";
import { NO_ATTENTION, reduceAttention } from "../shared/agentLife";

describe("signalFor", () => {
  // The producer-side mapping in canopy_hook (declared_state) and this one
  // must agree; these pin the receiving half. An explicit `canopy_signal`
  // always wins — the installer classified the moment, and re-deriving it
  // from the event name here is the two-regexes bug again.
  it("prefers the installer's explicit signal over the event name", () => {
    expect(signalFor({ event: "Stop", signal: "needs-human" })).toBe("needs-human");
  });

  it("maps the hook vocabulary", () => {
    expect(signalFor({ event: "UserPromptSubmit" })).toBe("turn-start");
    expect(signalFor({ event: "PostToolUse" })).toBe("turn-progress");
    expect(signalFor({ event: "Stop" })).toBe("turn-end");
    expect(signalFor({ event: "SessionEnd" })).toBe("session-end");
    expect(signalFor({ event: "PermissionRequest" })).toBe("needs-human-permission");
  });

  it("reads PreToolUse as progress, except a question to the human", () => {
    expect(signalFor({ event: "PreToolUse", tool: "Bash" })).toBe("turn-progress");
    expect(signalFor({ event: "PreToolUse", tool: "AskUserQuestion" })).toBe("needs-human");
  });

  it("answers null for an event it does not know — never a guess", () => {
    expect(signalFor({ event: "SomethingNew" })).toBeNull();
    expect(signalFor({})).toBeNull();
  });
});

describe("the fast lane end to end: signal → attention", () => {
  // What the wiring in ProjectView actually does with these signals. `blocked`
  // was unreachable before the hook lane fed the reducer; this pins that a
  // permission event now produces it, and that the agent moving on clears it.
  it("a permission request blocks, and the next turn clears it", () => {
    const blocked = reduceAttention(
      NO_ATTENTION,
      { t: "hook", at: 1, signal: signalFor({ event: "PermissionRequest" })! },
      "claude",
    );
    expect(blocked).toEqual({ kind: "blocked", since: 1, why: "permission" });

    const cleared = reduceAttention(
      blocked,
      { t: "hook", at: 2, signal: signalFor({ event: "UserPromptSubmit" })! },
      "claude",
    );
    expect(cleared).toEqual({ kind: "none" });
  });

  it("a finished turn rings; looking clears the ring but never a block", () => {
    const rung = reduceAttention(
      NO_ATTENTION,
      { t: "hook", at: 5, signal: signalFor({ event: "Stop" })! },
      "claude",
    );
    expect(rung).toEqual({ kind: "unseen", since: 5, why: "finished" });
    expect(
      reduceAttention(rung, { t: "focus", at: 6, visible: true }, "claude"),
    ).toEqual({ kind: "none" });

    const blocked = reduceAttention(
      NO_ATTENTION,
      { t: "hook", at: 7, signal: "needs-human" },
      "claude",
    );
    expect(
      reduceAttention(blocked, { t: "focus", at: 8, visible: true }, "claude"),
    ).toBe(blocked);
  });
});

import { describe, expect, it } from "vitest";
import { LIVE_NARRATIVE_EVERY_MS, narrativeDue, type CachedNarrative } from "./narrative";

const hit = (over: Partial<CachedNarrative> = {}): CachedNarrative => ({
  narrative: { summary: "s", decisions: [], openQuestions: [], nextSteps: [], risks: [] },
  turnKey: "t2",
  at: 1_000,
  turns: 2,
  ...over,
});
const doc = (turns: number, key = `t${turns}`) => ({ lastTurnKey: key, turns: new Array(turns).fill(null) });

describe("narrativeDue", () => {
  it("is due with nothing cached, never for the turn it was written for", () => {
    expect(narrativeDue(null, doc(1))).toBe(true);
    expect(narrativeDue(hit(), doc(2), { live: true })).toBe(false);
  });

  it("is due on any newer turn of a past session", () => {
    expect(narrativeDue(hit(), doc(3))).toBe(true);
  });

  it("paces a running session by turns or minutes", () => {
    expect(narrativeDue(hit(), doc(3), { live: true, now: 2_000 })).toBe(false);
    expect(narrativeDue(hit(), doc(4), { live: true, now: 2_000 })).toBe(false);
    expect(narrativeDue(hit(), doc(5), { live: true, now: 2_000 })).toBe(true);
    expect(narrativeDue(hit(), doc(3), { live: true, now: 1_000 + LIVE_NARRATIVE_EVERY_MS })).toBe(true);
    // Written before turn counts were kept: treat it as due.
    expect(narrativeDue(hit({ turns: undefined }), doc(3), { live: true, now: 2_000 })).toBe(true);
  });
});

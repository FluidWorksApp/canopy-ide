import { describe, expect, it } from "vitest";
import {
  ASH_STATES,
  ASH_TONE_VARS,
  ashArcPath,
  ashFor,
  ashGlyph,
  ashMayInterrupt,
  ashMetrics,
  ashTier,
  ashTone,
  type AshState,
} from "./ash";

describe("ashFor", () => {
  it("gives every lifecycle state the panel can show a face", () => {
    expect(ashFor("working")).toEqual({ state: "thinking", tone: "ok" });
    expect(ashFor("waiting")).toEqual({ state: "needs", tone: "warn" });
    expect(ashFor("idle")).toEqual({ state: "done", tone: "dim" });
    expect(ashFor("ended")).toEqual({ state: "sleeping", tone: "dim" });
  });

  // The panel distinguishes "session ended" from "we lost track of it" by the
  // dot's colour, not its shape. Ash has to keep that apart or `stale` reads as
  // a clean exit.
  it("separates a lost agent from a finished one by tone, not face", () => {
    expect(ashFor("stale").state).toBe(ashFor("ended").state);
    expect(ashFor("stale").tone).not.toBe(ashFor("ended").tone);
  });

  it("falls back to idle for a session nothing has spoken for", () => {
    expect(ashFor(undefined).state).toBe("idle");
    expect(ashFor(null).state).toBe("idle");
    expect(ashFor("something-a-future-cli-invents").state).toBe("idle");
  });
});

describe("tones", () => {
  it("resolves every state to a token the stylesheet defines", () => {
    for (const state of ASH_STATES) {
      expect(ASH_TONE_VARS[ashTone(state)]).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it("keeps the two states that may interrupt on the loud tokens", () => {
    expect(ashTone("needs")).toBe("warn");
    expect(ashTone("blocked")).toBe("danger");
  });
});

describe("ashGlyph", () => {
  it("gives every state a distinct two-character form", () => {
    const seen = new Set(ASH_STATES.map(ashGlyph));
    expect(seen.size).toBe(ASH_STATES.length);
  });

  it("keeps every glyph four columns wide so a status list lines up", () => {
    for (const state of ASH_STATES) {
      const g = ashGlyph(state);
      expect(g, state).toMatch(/^\[..\]$/);
      expect([...g].length, state).toBe(4);
    }
  });
});

describe("ashMayInterrupt", () => {
  it("is exactly needs and blocked", () => {
    const may = ASH_STATES.filter(ashMayInterrupt);
    expect(may).toEqual<AshState[]>(["needs", "blocked"]);
  });
});

describe("the size ladder", () => {
  it("reproduces every size the spec draws", () => {
    expect(ashTier(312)).toBe("full");
    expect(ashTier(112)).toBe("full");
    expect(ashTier(76)).toBe("full");
    expect(ashTier(72)).toBe("full");
    expect(ashTier(64)).toBe("full");
    expect(ashTier(52)).toBe("full");
    expect(ashTier(44)).toBe("full");
    expect(ashTier(32)).toBe("compact");
    expect(ashTier(24)).toBe("small");
    expect(ashTier(17)).toBe("mono");
    expect(ashTier(16)).toBe("mono");
  });

  it("drops the mouth at 32 and below", () => {
    expect(ashMetrics(33).mouth).toBe(true);
    expect(ashMetrics(32).mouth).toBe(false);
    expect(ashMetrics(16).mouth).toBe(false);
  });

  it("drops everything but the arc and eyes below 24", () => {
    expect(ashMetrics(24).expressive).toBe(false);
    expect(ashMetrics(16).expressive).toBe(false);
    expect(ashMetrics(32).expressive).toBe(true);
  });

  it("thickens the stroke and grows the eyes as it shrinks", () => {
    const sizes = [64, 32, 24, 16];
    const strokes = sizes.map((s) => ashMetrics(s).stroke);
    const eyes = sizes.map((s) => ashMetrics(s).eye.r);
    expect(strokes).toEqual([...strokes].sort((a, b) => a - b));
    expect(eyes).toEqual([...eyes].sort((a, b) => a - b));
  });

  it("goes monochrome only at the smallest tier", () => {
    expect(ashMetrics(16).monochrome).toBe(true);
    expect(ashMetrics(24).monochrome).toBe(false);
  });

  it("keeps the favicon's own arc at every tier that isn't the smallest", () => {
    for (const size of [312, 64, 32, 24]) {
      expect(ashMetrics(size).arc, `${size}px`).toEqual({
        r: 11.2,
        x0: 8.8,
        x1: 31.2,
        y: 19.6,
      });
    }
  });
});

describe("ashArcPath", () => {
  it("draws the favicon's canopy at the mark's own proportions", () => {
    expect(ashArcPath(ashMetrics(64).arc)).toBe("M8.8 19.6 A11.2 11.2 0 0 1 31.2 19.6");
  });

  it("tightens the arc at 16px, where the mark is two dots under a curve", () => {
    expect(ashArcPath(ashMetrics(16).arc)).toBe("M9.4 20 A10.6 10.6 0 0 1 30.6 20");
  });
});

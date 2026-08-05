// A restore that focuses nothing looks exactly like a restore that failed: the
// strip comes back full, the agents underneath load and start answering, and
// the workspace stays blank until the user clicks a tab. These are the two
// places that decide which tab a restore leaves in front.
import { describe, expect, it } from "vitest";
import { restoredFront } from "./helpers";

describe("restoredFront", () => {
  it("puts back the tab that was in front", () => {
    expect(restoredFront(["a", "b", "c"], 1)).toBe("b");
  });

  it("falls back to the first tab that came back when that one didn't", () => {
    // The front tab is the likeliest casualty — a deleted file, a dead portal
    // PTY, a session the CLI refused to resume.
    expect(restoredFront([null, "b", "c"], 0)).toBe("b");
    expect(restoredFront(["a", "b", null], 2)).toBe("a");
  });

  it("focuses the first tab when the caller records no preference", () => {
    // Resuming an agent session from the empty state: nothing carries an index,
    // and the resumed terminals are opened deactivated on purpose so the strip
    // doesn't thrash while several come back.
    expect(restoredFront(["a", "b"], null)).toBe("a");
    expect(restoredFront([null, "b"], null)).toBe("b");
  });

  it("answers null only when nothing came back at all", () => {
    expect(restoredFront([], 0)).toBeNull();
    expect(restoredFront([null, null], 1)).toBeNull();
  });

  it("survives an index the snapshot no longer has tabs for", () => {
    expect(restoredFront(["a"], 7)).toBe("a");
  });
});

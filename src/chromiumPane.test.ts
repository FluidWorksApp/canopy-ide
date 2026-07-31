// The pane's one real decision: when a size change is worth restarting the
// stream for. A pane drag emits hundreds of sizes and each restart costs a
// round trip and shows a gap, so this has to reject nearly all of them.
import { describe, expect, it } from "vitest";
import { worthRecasting } from "./chromiumPane";

describe("worthRecasting", () => {
  it("always casts the first time", () => {
    expect(worthRecasting(null, { width: 800, height: 600 })).toBe(true);
  });

  it("ignores the jitter of a drag", () => {
    const from = { width: 800, height: 600 };
    expect(worthRecasting(from, { width: 803, height: 600 })).toBe(false);
    expect(worthRecasting(from, { width: 800, height: 604 })).toBe(false);
    expect(worthRecasting(from, from)).toBe(false);
  });

  it("recasts once a pane has genuinely changed shape", () => {
    const from = { width: 800, height: 600 };
    expect(worthRecasting(from, { width: 812, height: 600 })).toBe(true);
    expect(worthRecasting(from, { width: 800, height: 588 })).toBe(true);
  });

  // A collapsed pane happens mid-drag and while a tab is transitioning. Casting
  // into a zero-sized box asks Chrome for frames nobody will ever see.
  it("never casts into a collapsed pane", () => {
    expect(worthRecasting({ width: 800, height: 600 }, { width: 0, height: 600 })).toBe(false);
    expect(worthRecasting(null, { width: 800, height: 0 })).toBe(false);
  });
});

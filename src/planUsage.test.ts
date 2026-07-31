import { describe, expect, it } from "vitest";
import type { PlanUsage } from "./ipc";
import {
  chipText,
  planFor,
  planLabel,
  planTone,
  resetText,
  stalenessText,
  tooltip,
} from "./planUsage";

const NOW = 1_785_200_000_000; // fixed clock; these helpers must not read Date.now themselves
const nowSecs = Math.floor(NOW / 1000);

const plan = (over: Partial<PlanUsage> = {}): PlanUsage => ({
  agent: "claude",
  profile: "default",
  plan: "default_claude_max_20x",
  windows: [
    { label: "5h", used_percent: 18, resets_at: nowSecs + 2 * 3600 + 49 * 60 },
    { label: "7d", used_percent: 52, resets_at: nowSecs + 60 * 3600 },
  ],
  credits: null,
  observed: nowSecs,
  ...over,
});

describe("chipText", () => {
  it("shows every window, most-constrained first", () => {
    expect(chipText(plan())).toBe("7d 52% · 5h 18%");
  });

  it("rounds rather than truncating, matching what /usage prints", () => {
    const p = plan({
      windows: [{ label: "5h", used_percent: 17.6, resets_at: null }],
    });
    expect(chipText(p)).toBe("5h 18%");
  });
});

describe("planTone", () => {
  it("is driven by the worst window, not the average", () => {
    // A spent weekly window blocks work however empty the session window is.
    const p = plan({
      windows: [
        { label: "5h", used_percent: 0, resets_at: null },
        { label: "7d", used_percent: 96, resets_at: null },
      ],
    });
    expect(planTone(p)).toBe("critical");
  });

  it("warns before the limit is reached, not after", () => {
    expect(planTone(plan({ windows: [{ label: "7d", used_percent: 80, resets_at: null }] }))).toBe(
      "warn",
    );
    expect(planTone(plan({ windows: [{ label: "7d", used_percent: 52, resets_at: null }] }))).toBe(
      "normal",
    );
  });

  it("does not crash on a plan with no windows", () => {
    expect(planTone(plan({ windows: [] }))).toBe("normal");
  });
});

describe("resetText", () => {
  it("formats hours and minutes", () => {
    expect(resetText(plan().windows[0], NOW)).toBe("resets in 2h 49m");
  });

  it("switches to days past 24h", () => {
    expect(resetText(plan().windows[1], NOW)).toBe("resets in 2d 12h");
  });

  it("reports a window whose reset has passed as resetting now", () => {
    const w = { label: "5h", used_percent: 99, resets_at: nowSecs - 10 };
    expect(resetText(w, NOW)).toBe("resetting now");
  });

  it("returns null when the provider gave no reset time", () => {
    expect(resetText({ label: "7d", used_percent: 5, resets_at: null }, NOW)).toBeNull();
  });
});

describe("stalenessText", () => {
  it("stays quiet while the reading is fresh", () => {
    expect(stalenessText(plan(), NOW)).toBeNull();
  });

  // The case this exists for: a rate-limited request returns no limit headers,
  // so the snapshot necessarily ages exactly when the user is blocked.
  it("dates an old reading rather than hiding it", () => {
    expect(stalenessText(plan({ observed: nowSecs - 3 * 3600 }), NOW)).toBe("as of 3h ago");
    expect(stalenessText(plan({ observed: nowSecs - 90 * 60 }), NOW)).toBe("as of 1h ago");
    expect(stalenessText(plan({ observed: nowSecs - 40 * 60 }), NOW)).toBe("as of 40m ago");
  });

  it("has nothing to say when the snapshot is undated", () => {
    expect(stalenessText(plan({ observed: 0 }), NOW)).toBeNull();
  });
});

describe("planLabel", () => {
  it("renders the tier names the providers actually emit", () => {
    expect(planLabel(plan())).toBe("Max (20x)");
    expect(planLabel(plan({ plan: "free" }))).toBe("Free");
  });

  it("passes an unrecognised tier through instead of dropping it", () => {
    expect(planLabel(plan({ plan: "default_claude_max_50x" }))).toBe("claude max 50x");
  });

  it("is null when the CLI named no plan", () => {
    expect(planLabel(plan({ plan: null }))).toBeNull();
  });
});

describe("tooltip", () => {
  it("names the plan and spells out each window", () => {
    expect(tooltip(plan(), NOW)).toBe(
      ["Max (20x)", "5h: 18% used · resets in 2h 49m", "7d: 52% used · resets in 2d 12h"].join("\n"),
    );
  });

  it("appends the age once the reading is stale", () => {
    expect(tooltip(plan({ observed: nowSecs - 7200 }), NOW)).toContain("as of 2h ago");
  });
});

describe("planFor", () => {
  const plans = [plan(), plan({ agent: "codex", plan: "free" })];

  it("picks the row for the tray's CLI", () => {
    expect(planFor(plans, "codex")?.plan).toBe("free");
  });

  // Never fall back to another CLI's plan: showing Codex's headroom on a
  // Claude tab would be actively misleading.
  it("returns null for a CLI that reports nothing", () => {
    expect(planFor(plans, "amp")).toBeNull();
    expect(planFor(plans, null)).toBeNull();
  });
});

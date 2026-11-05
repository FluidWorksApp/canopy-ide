import { describe, expect, it } from "vitest";
import { carriedFlags, earliestReset, handoverLine, limitKey, limitResetAt, nextAccount, parseResetTime, windowSpent, withPrompt } from "./accountPool";

const now = new Date(2026, 10, 5, 10, 0, 0);
const round = (from: string, limited: string[] = [], signedIn = ["a", "b", "c"]) => nextAccount({
  cli: "claude", from, order: ["a", "b", "c"], signedIn, now: now.getTime(),
  limits: Object.fromEntries(limited.map(id => [limitKey("claude", id), { until: now.getTime() + 1000 }])),
});

describe("reset times", () => {
  it("reads the wordings Claude really prints", () => {
    expect(new Date(parseResetTime("You've hit your weekly limit · resets 4am (Asia/Bangkok)", now)!)).toEqual(new Date(2026, 10, 6, 4));
    expect(new Date(parseResetTime("You've hit your weekly limit · resets 3:30pm (Asia/Bangkok)", now)!)).toEqual(new Date(2026, 10, 5, 15, 30));
    expect(new Date(parseResetTime("You've hit your weekly limit · resets Nov 7 at 4am (Asia/Bangkok)", now)!)).toEqual(new Date(2026, 10, 7, 4));
    expect(new Date(parseResetTime("resets Jan 2 at 12pm", now)!)).toEqual(new Date(2027, 0, 2, 12));
  });
  it("falls back to a spent window, then to looking again later", () => {
    const seconds = now.getTime() / 1000;
    expect(limitResetAt("API Error: Rate limit reached", [{ used_percent: 100, resets_at: seconds + 50 }, { used_percent: 10, resets_at: seconds + 90 }], now)).toBe((seconds + 50) * 1000);
    expect(limitResetAt("API Error: Rate limit reached", [], now)).toBe(now.getTime() + 3600_000);
  });
  it("ignores a window that has already reset", () => {
    const seconds = now.getTime() / 1000;
    expect(windowSpent([{ used_percent: 100, resets_at: seconds - 1 }], now)).toBeNull();
    expect(windowSpent([{ used_percent: 99.5, resets_at: seconds + 1 }], now)).not.toBeNull();
  });
});

describe("rotation", () => {
  it("goes round and wraps", () => {
    expect(round("a", ["a"])).toBe("b");
    expect(round("c", ["c"])).toBe("a");
  });
  it("skips limited and signed-out accounts", () => {
    expect(round("a", ["a", "b"])).toBe("c");
    expect(round("a", ["a"], ["a", "c"])).toBe("c");
  });
  it("is null only when everything is exhausted", () => {
    expect(round("a", ["a", "b", "c"])).toBeNull();
  });
  it("treats an expired limit as available", () => {
    const limits = { [limitKey("claude", "b")]: { until: now.getTime() - 1 }, [limitKey("claude", "a")]: { until: now.getTime() + 9 } };
    expect(nextAccount({ cli: "claude", from: "a", order: ["a", "b"], signedIn: ["a", "b"], limits, now: now.getTime() })).toBe("b");
  });
  it("keeps each CLI's limits apart", () => {
    const limits = { [limitKey("codex", "b")]: { until: now.getTime() + 9 } };
    expect(nextAccount({ cli: "claude", from: "a", order: ["a", "b"], signedIn: ["a", "b"], limits, now: now.getTime() })).toBe("b");
  });
  it("retries at the first reset", () => {
    const t = now.getTime();
    expect(earliestReset("claude", ["a", "b"], { "claude:a": { until: t + 50 }, "claude:b": { until: t + 20 } }, t)).toBe(t + 20);
  });
});

describe("the relaunch line", () => {
  it("runs in the verified directory and switches the account", () => {
    expect(handoverLine({ cwd: "/w/it's", set: [["CLAUDE_CONFIG_DIR", "/p/b"]], clear: [], command: "claude --resume x" }))
      .toBe(`\x15 cd '/w/it'\\''s' && export CLAUDE_CONFIG_DIR='/p/b' && claude --resume x\r`);
  });
  it("clears the old account when moving to the default login", () => {
    expect(handoverLine({ cwd: "/w", set: [], clear: ["CLAUDE_CONFIG_DIR", "CANOPY_PROFILE"], command: "claude" }))
      .toBe(`\x15 cd '/w' && unset CLAUDE_CONFIG_DIR CANOPY_PROFILE && claude\r`);
  });
  it("puts the prompt beside the id, clear of variadic flags", () => {
    expect(withPrompt("claude --resume x --add-dir /a", "x", "go on")).toBe("claude --resume x 'go on' --add-dir /a");
    expect(withPrompt("codex resume x --no-daemon", "x", "it's")).toBe(`codex resume x 'it'\\''s' --no-daemon`);
  });
  it("keeps the model choices a resume would drop", () => {
    expect(carriedFlags(["--model", "--effort"], "claude --model opus --effort=high --verbose")).toEqual(["--model opus", "--effort high"]);
    expect(carriedFlags(["--model", "-m"], "codex -m gpt-5 resume x")).toEqual(["-m gpt-5"]);
    expect(carriedFlags(["--model"], undefined)).toEqual([]);
    expect(carriedFlags([], "claude --model opus")).toEqual([]);
  });
});

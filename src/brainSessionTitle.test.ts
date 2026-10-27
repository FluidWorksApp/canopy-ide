import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./brainCall", () => ({ askBrain: vi.fn() }));

import { askBrain } from "./brainCall";
import {
  brainSessionTitle,
  buildSessionTitlePrompt,
  cachedSessionTitle,
  promptKey,
  requestBrainTabName,
  resetBrainSessionTitlesForTests,
  validateSessionTitle,
  worthTitling,
} from "./brainSessionTitle";
import { updateSettings } from "./settings";
import { tabName, type NamedTab } from "./tabName";

const askMock = askBrain as unknown as ReturnType<typeof vi.fn>;
const PROMPT = "the login page keeps redirecting back to itself after I sign in, can you find out why";

function answers(value: unknown) {
  askMock.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => {
    const v = req.validate(value);
    return v ? { ok: true, text: JSON.stringify(value), value: v, costUsd: 0.001 } : { ok: false, reason: "invalid-output", message: "" };
  });
}

beforeEach(() => {
  localStorage.clear();
  resetBrainSessionTitlesForTests();
  askMock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("prompt and validation", () => {
  it("asks for a short title and summary over the opening message", () => {
    const p = buildSessionTitlePrompt(`  ${PROMPT}\n\n`);
    expect(p).toContain(`<<<\n${PROMPT}\n>>>`);
    expect(p).toMatch(/"title": 2 to 6 words/);
    expect(p).toMatch(/"summary": one plain sentence/);
  });

  it("clips a very long brief", () => {
    expect(buildSessionTitlePrompt("x ".repeat(5000))).toContain("[…]");
  });

  it("accepts a sensible reply and rejects junk", () => {
    expect(validateSessionTitle({ title: '"Fix login redirect loop."', summary: "Find why sign-in loops." })).toEqual({
      title: "Fix login redirect loop",
      summary: "Find why sign-in loops.",
    });
    expect(validateSessionTitle({ title: "Untitled", summary: "" })).toBeNull();
    expect(validateSessionTitle({ title: "x" })).toBeNull();
    expect(validateSessionTitle({ title: "one two three four five six seven eight nine ten eleven" })).toBeNull();
    expect(validateSessionTitle("Fix it")).toBeNull();
  });

  it("only titles a person's prompt that's long enough to need it", () => {
    expect(worthTitling(PROMPT)).toBe(true);
    expect(worthTitling("hi")).toBe(false);
    expect(worthTitling("<task-notification>something long enough to count</task-notification>")).toBe(false);
    expect(worthTitling(undefined)).toBe(false);
  });

  it("keys the cache on content, not whitespace", () => {
    expect(promptKey(`${PROMPT}\n`)).toBe(promptKey(PROMPT.replace(/ /g, "  ")));
    expect(promptKey(PROMPT)).not.toBe(promptKey(`${PROMPT}!`));
  });
});

describe("brainSessionTitle", () => {
  it("asks once on the background tier and caches the answer", async () => {
    answers({ title: "Fix login redirect loop", summary: "Find why sign-in loops back." });
    const [a, b] = await Promise.all([brainSessionTitle(PROMPT), brainSessionTitle(PROMPT)]);
    expect(a).toEqual(b);
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock.mock.calls[0][0]).toMatchObject({ feature: "session-title", tier: "background", json: true, cwd: "" });
    expect(cachedSessionTitle(PROMPT)?.title).toBe("Fix login redirect loop");
    await brainSessionTitle(PROMPT);
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when switched off", async () => {
    updateSettings({ brainSessionTitles: false });
    expect(await brainSessionTitle(PROMPT)).toBeNull();
    expect(askMock).not.toHaveBeenCalled();
  });

  it("does not retry a prompt whose reply was unusable", async () => {
    answers({ title: "Untitled" });
    expect(await brainSessionTitle(PROMPT)).toBeNull();
    expect(await brainSessionTitle(PROMPT)).toBeNull();
    expect(askMock).toHaveBeenCalledTimes(1);
  });
});

describe("requestBrainTabName", () => {
  it("titles the tab after the grace when its agent stayed quiet", async () => {
    vi.useFakeTimers();
    answers({ title: "Fix login redirect loop", summary: "" });
    let tab: NamedTab = { promptName: "the login page keeps redirecting…" };
    requestBrainTabName({ prompt: PROMPT, tab: () => tab, apply: (p) => (tab = { ...tab, ...p }), graceMs: 1000 });
    expect(askMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tabName(tab)).toBe("Fix login redirect loop");
  });

  it("never overrides the agent's own name or the user's", async () => {
    vi.useFakeTimers();
    answers({ title: "Fix login redirect loop", summary: "" });
    let tab: NamedTab = { promptName: "p" };
    requestBrainTabName({ prompt: PROMPT, tab: () => tab, apply: (p) => (tab = { ...tab, ...p }), graceMs: 1000 });
    tab = { ...tab, agentName: "Login redirect bug" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(askMock).not.toHaveBeenCalled();
    expect(tabName(tab)).toBe("Login redirect bug");
  });
});

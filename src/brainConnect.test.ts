import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./brainStatus", () => {
  let state = { state: "unknown", cli: null, label: null, checkedAt: null } as Record<string, unknown>;
  return {
    brainConnection: () => state,
    checkBrainConnection: vi.fn(async () => state),
    subscribeBrainConnection: () => () => {},
    __set: (next: Record<string, unknown>) => {
      state = next;
    },
  };
});

import * as status from "./brainStatus";
import {
  BRAIN_RECHECK,
  brainCandidates,
  brainExceptions,
  brainNeedsConnect,
  brainStateText,
  canBeBrain,
  chooseBrain,
  initBrainConnect,
  loginPollTick,
  resetBrainConnectForTests,
  parseBudget,
  recommendedBrain,
  runInProjectTerminal,
  startBrainSignIn,
  TERMINAL_EXITED_EVENT,
} from "./brainConnect";
import { AGENT_CLIS, agentCliFor, CLI_INSTALLS_CHANGED_EVENT } from "./projects";
import { getSettings, updateSettings } from "./settings";

const checkMock = status.checkBrainConnection as unknown as ReturnType<typeof vi.fn>;
const setState = (status as unknown as { __set: (s: Record<string, unknown>) => void }).__set;

const claude = agentCliFor("claude")!;
const codex = agentCliFor("codex")!;
const amp = agentCliFor("amp")!;
const only = (...bins: string[]) => (bin: string) => bins.includes(bin);

beforeEach(() => {
  localStorage.clear();
  checkMock.mockClear();
  setState({ state: "unknown", cli: null, label: null, checkedAt: null });
});

describe("which CLIs can be the brain", () => {
  it("accepts verified one-shot runners and refuses CLIs without one", () => {
    expect(canBeBrain(claude)).toBe(true);
    expect(canBeBrain(codex)).toBe(true);
    expect(canBeBrain(amp)).toBe(false);
  });

  it("lists only installed capable CLIs, in registry order", () => {
    const found = brainCandidates(only(codex.bin, amp.bin, claude.bin));
    expect(found.map((c) => c.id)).toEqual(
      AGENT_CLIS.filter((c) => [claude.id, codex.id].includes(c.id)).map((c) => c.id),
    );
  });

  it("recommends the chosen brain when it can be one, else the first candidate", () => {
    updateSettings({ defaultAgent: codex.id });
    expect(recommendedBrain(only(claude.bin, codex.bin))?.id).toBe(codex.id);
    // A chosen CLI that cannot answer for features is skipped for one that can.
    updateSettings({ defaultAgent: amp.id });
    expect(recommendedBrain(only(amp.bin, codex.bin))?.id).toBe(codex.id);
    expect(recommendedBrain(only(amp.bin))).toBeNull();
  });

  it("choosing a brain stores it as the default agent and checks it", async () => {
    await chooseBrain(codex.id);
    expect(getSettings().defaultAgent).toBe(codex.id);
    expect(checkMock).toHaveBeenCalledTimes(1);
  });
});

describe("state copy", () => {
  it("says every state in words, naming the CLI", () => {
    expect(brainStateText({ state: "connected", label: "X" })).toMatchObject({ tone: "ok", short: "Connected" });
    expect(brainStateText({ state: "signed-out", label: "X" }).detail).toContain("X is installed but not signed in");
    expect(brainStateText({ state: "rate-limited", label: "X" }).tone).toBe("warn");
    expect(brainStateText({ state: "missing", label: null }).short).toBe("Not connected");
    expect(brainStateText({ state: "checking", label: null }).tone).toBe("busy");
  });

  it("asks for action only when the person has something to do", () => {
    expect(brainNeedsConnect("missing")).toBe(true);
    expect(brainNeedsConnect("signed-out")).toBe(true);
    for (const s of ["unknown", "checking", "connected", "rate-limited", "error"] as const)
      expect(brainNeedsConnect(s)).toBe(false);
  });
});

describe("terminal flows", () => {
  it("reports whether a project took the command", () => {
    expect(runInProjectTerminal("x", "x")).toBe(false);
    const take = (e: Event) => {
      (e as CustomEvent).detail.handled = true;
    };
    window.addEventListener("canopy:run-command", take);
    try {
      expect(runInProjectTerminal("x", "x")).toBe(true);
    } finally {
      window.removeEventListener("canopy:run-command", take);
    }
  });

  it("opens the CLI's own sign-in with a re-check marker", () => {
    const seen: Record<string, unknown>[] = [];
    const take = (e: Event) => {
      const d = (e as CustomEvent).detail;
      seen.push({ ...d });
      d.handled = true;
    };
    window.addEventListener("canopy:run-command", take);
    try {
      expect(startBrainSignIn(claude)).toBe(true);
    } finally {
      window.removeEventListener("canopy:run-command", take);
    }
    expect(seen[0]).toMatchObject({ command: claude.bin, then: BRAIN_RECHECK });
  });

  it("re-checks when a marked terminal exits or an install lands, and nothing else", () => {
    const stop = initBrainConnect({ probeOnStart: false });
    try {
      window.dispatchEvent(new CustomEvent(TERMINAL_EXITED_EVENT, { detail: { then: "other" } }));
      expect(checkMock).not.toHaveBeenCalled();
      window.dispatchEvent(new CustomEvent(TERMINAL_EXITED_EVENT, { detail: { then: BRAIN_RECHECK, code: 0 } }));
      expect(checkMock).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event(CLI_INSTALLS_CHANGED_EVENT));
      expect(checkMock).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
    window.dispatchEvent(new Event(CLI_INSTALLS_CHANGED_EVENT));
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("checks every few seconds while a sign-in tab is open, and flips the moment it works", () => {
    vi.useFakeTimers();
    resetBrainConnectForTests();
    const take = (e: Event) => ((e as CustomEvent).detail.handled = true);
    window.addEventListener("canopy:run-command", take);
    const stop = initBrainConnect({ probeOnStart: false });
    try {
      setState({ state: "signed-out", cli: "claude", label: "Claude Code", checkedAt: 1 });
      startBrainSignIn(claude);
      vi.advanceTimersByTime(20_000);
      const fast = checkMock.mock.calls.length;
      expect(fast).toBeGreaterThanOrEqual(4);
      expect(fast).toBeLessThanOrEqual(6);
      // Sign-in finished: the next probe says connected and the polling stops.
      setState({ state: "connected", cli: "claude", label: "Claude Code", checkedAt: 2 });
      vi.advanceTimersByTime(60_000);
      expect(checkMock.mock.calls.length).toBe(fast);
    } finally {
      stop();
      window.removeEventListener("canopy:run-command", take);
      vi.useRealTimers();
    }
  });

  it("slows the sign-in checks down, then stops them with the tab or the window", () => {
    resetBrainConnectForTests();
    const take = (e: Event) => ((e as CustomEvent).detail.handled = true);
    window.addEventListener("canopy:run-command", take);
    const t0 = Date.now();
    try {
      setState({ state: "signed-out", cli: "claude", label: "Claude Code", checkedAt: 1 });
      startBrainSignIn(claude);
      // Fast stage: one probe per few seconds, never two at once.
      expect(loginPollTick(t0 + 4_000)).toBe(true);
      expect(loginPollTick(t0 + 5_000)).toBe(false);
      setState({ state: "checking", cli: "claude", label: "Claude Code", checkedAt: 1 });
      expect(loginPollTick(t0 + 20_000)).toBe(false);
      setState({ state: "signed-out", cli: "claude", label: "Claude Code", checkedAt: 1 });
      // Slow stage after five minutes.
      expect(loginPollTick(t0 + 6 * 60_000)).toBe(true);
      expect(loginPollTick(t0 + 6 * 60_000 + 10_000)).toBe(false);
      expect(loginPollTick(t0 + 6 * 60_000 + 31_000)).toBe(true);
      // The sign-in window closes.
      expect(loginPollTick(t0 + 16 * 60_000)).toBe(false);
      expect(loginPollTick(t0 + 17 * 60_000)).toBe(false);

      // And the tab exiting ends it at once.
      startBrainSignIn(claude);
      const stop = initBrainConnect({ probeOnStart: false });
      window.dispatchEvent(new CustomEvent(TERMINAL_EXITED_EVENT, { detail: { then: BRAIN_RECHECK, code: 0 } }));
      stop();
      expect(loginPollTick(Date.now() + 10_000)).toBe(false);
    } finally {
      window.removeEventListener("canopy:run-command", take);
    }
  });

  it("probes once at start when nobody has", () => {
    vi.useFakeTimers();
    try {
      const stop = initBrainConnect();
      vi.advanceTimersByTime(5_000);
      expect(checkMock).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("exceptions", () => {
  it("names a companion running on another CLI, with a reset to the brain", () => {
    updateSettings({ defaultAgent: claude.id, companionCli: codex.id, companionModel: "" });
    const list = brainExceptions(getSettings(), only(claude.bin, codex.bin));
    expect(list).toEqual([
      { feature: "Companion", uses: codex.name, reset: { companionCli: "", companionModel: "" } },
    ]);
  });

  it("names a companion model override on the brain itself", () => {
    updateSettings({ defaultAgent: claude.id, companionCli: "", companionModel: "opus" });
    expect(brainExceptions(getSettings(), only(claude.bin))[0]).toMatchObject({ uses: "the opus model" });
  });

  it("is empty when the companion follows the brain, or names a CLI that isn't installed", () => {
    updateSettings({ defaultAgent: claude.id, companionCli: "", companionModel: "" });
    expect(brainExceptions(getSettings(), only(claude.bin))).toEqual([]);
    updateSettings({ companionCli: codex.id });
    expect(brainExceptions(getSettings(), only(claude.bin))).toEqual([]);
  });
});

describe("budgets", () => {
  it("parses blank as no cap and rejects nonsense", () => {
    expect(parseBudget("")).toBeNull();
    expect(parseBudget(" 2.5 ")).toBe(2.5);
    expect(parseBudget("$3")).toBe(3);
    expect(parseBudget("-1")).toBeUndefined();
    expect(parseBudget("abc")).toBeUndefined();
  });
});

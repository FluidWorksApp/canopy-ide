import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentHint } from "../ipc";
import {
  countStopTargets,
  countTerminals,
  hostNoticeMessages,
  lingerText,
  startQuitStopAll,
  type StopTarget,
  stopAllMeta,
  stopAllTitle,
  type QuitStopAllAsk,
} from "../quitStopAll";
import { QuitStopAllDialog } from "./QuitStopAllDialog";

const agent = (bin: string): { agent_hint: AgentHint } => ({
  agent_hint: { bin, pkg: null, path: `/usr/local/bin/${bin}`, interactive: true },
});
const shell = { agent_hint: null };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("counting terminals", () => {
  it("counts a terminal with an agent in the foreground as an agent, the rest as shells", () => {
    expect(countTerminals([agent("claude"), agent("codex"), shell, agent("claude"), shell])).toEqual({
      agents: 3,
      shells: 2,
    });
    // A script in the foreground is not an agent (the same rule as the panel).
    expect(
      countTerminals([{ agent_hint: { bin: "node", pkg: null, path: "/usr/bin/node", interactive: false } }]),
    ).toEqual({ agents: 0, shells: 1 });
  });

  it("spells the title and the count line", () => {
    expect(stopAllTitle(3)).toBe("Stop 3 running agents?");
    expect(stopAllTitle(1)).toBe("Stop 1 running agent?");
    expect(stopAllTitle(0)).toBe("Stop all terminals?");
    expect(stopAllMeta({ agents: 3, shells: 2 })).toBe("3 agents · 2 shells");
    expect(stopAllMeta({ agents: 1, shells: 1 })).toBe("1 agent · 1 shell");
    expect(stopAllMeta({ agents: 2, shells: 0 })).toBe("2 agents");
  });
});

describe("Quit and Stop All", () => {
  const run = (
    stats: { agent_hint: AgentHint | null }[],
    opts: { hostOn?: boolean; quit?: () => Promise<unknown>; foreign?: StopTarget[]; linger?: number } = {},
  ) => {
    const quit = vi.fn(opts.quit ?? (async () => {}));
    const ask = vi.fn<(a: QuitStopAllAsk) => void>();
    const done = startQuitStopAll({
      stats: async () => stats,
      foreign: async () => opts.foreign ?? [],
      lingerSecs: async () => opts.linger ?? 7200,
      hostOn: async () => opts.hostOn ?? true,
      quit,
      ask,
    });
    return { quit, ask, done };
  };

  for (const hostOn of [true, false]) {
    it(`stops everything and quits at once when no agent is running (host ${hostOn ? "on" : "off"})`, async () => {
      const { quit, ask, done } = run([shell, shell], { hostOn });
      await done;
      expect(quit).toHaveBeenCalledWith(true);
      expect(ask).not.toHaveBeenCalled();
    });

    it(`asks first when agents are running, and does not quit yet (host ${hostOn ? "on" : "off"})`, async () => {
      const { quit, ask, done } = run([agent("claude"), agent("codex"), shell], { hostOn });
      await done;
      expect(ask).toHaveBeenCalledWith({
        counts: { agents: 2, shells: 1 },
        hostOn,
        background: 0,
        lingerSecs: 7200,
      });
      expect(quit).not.toHaveBeenCalled();
    });
  }

  it("quits with no terminals at all", async () => {
    const { quit, ask, done } = run([]);
    await done;
    expect(quit).toHaveBeenCalledWith(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("opens the dialog with the error when stopping fails with no agent running", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ask, done } = run([shell], {
      quit: () => Promise.reject("Could not reach the terminal host: timed out"),
    });
    await done;
    expect(ask).toHaveBeenCalledWith({
      counts: { agents: 0, shells: 1 },
      hostOn: true,
      background: 0,
      lingerSecs: 7200,
      error: "Could not reach the terminal host: timed out",
    });
  });

  const claude: StopTarget = { command: "claude --resume", unreadable: false };
  const zsh: StopTarget = { command: null, unreadable: false };
  const garbled: StopTarget = { command: null, unreadable: true };

  it("asks first when only shells are open but Stop All would also kill an agent left in the host", async () => {
    const { quit, ask, done } = run([shell], { foreign: [claude, zsh] });
    await done;
    expect(quit).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith({
      counts: { agents: 1, shells: 2 },
      hostOn: true,
      background: 2,
      lingerSecs: 7200,
    });
  });

  it("asks first for a session it cannot identify, which may be an agent", async () => {
    const { quit, ask, done } = run([shell], { foreign: [garbled] });
    await done;
    expect(quit).not.toHaveBeenCalled();
    expect(ask.mock.calls[0][0].counts).toEqual({ agents: 0, shells: 1, unknown: 1 });
  });

  it("still quits at once when what is left in the host is only shells", async () => {
    const { quit, ask, done } = run([shell], { foreign: [zsh] });
    await done;
    expect(quit).toHaveBeenCalledWith(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("goes on to the stop, which reports the failure, when the host's sessions cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const quit = vi.fn(async () => {});
    const ask = vi.fn();
    await startQuitStopAll({
      stats: async () => [shell],
      foreign: () => Promise.reject("timed out"),
      lingerSecs: async () => 0,
      hostOn: async () => true,
      quit,
      ask,
    });
    expect(quit).toHaveBeenCalledWith(true);
  });

  it("counts host sessions the way tabs are counted", () => {
    expect(countStopTargets([claude, zsh, garbled, claude])).toEqual({ agents: 2, shells: 1, unknown: 1 });
    expect(stopAllMeta({ agents: 1, shells: 2, unknown: 1 })).toBe("1 agent · 2 shells · 1 unidentified");
    expect(stopAllMeta({ agents: 0, shells: 0, unknown: 1 })).toBe("1 unidentified");
  });

  it("spells the linger and the host notices", () => {
    expect(lingerText(7200)).toBe("2 hours");
    expect(lingerText(3600)).toBe("1 hour");
    expect(lingerText(5400)).toBe("90 minutes");
    expect(hostNoticeMessages({ fell_back: false, left_behind: [], linger_secs: 7200 })).toEqual([]);
    const both = hostNoticeMessages({
      fell_back: true,
      left_behind: [{ terminal: 3, reason: "x" }],
      linger_secs: 7200,
    });
    expect(both.map((m) => m[2])).toEqual(["pty-host-fell-back", "pty-host-left-behind"]);
    expect(both[0][1]).toContain("end when you quit");
  });

  it("does nothing when the terminals cannot be read, rather than stop blind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const quit = vi.fn();
    const ask = vi.fn();
    await startQuitStopAll({ stats: () => Promise.reject(new Error("gone")), foreign: async () => [], lingerSecs: async () => 0, hostOn: async () => true, quit, ask });
    expect(quit).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("the dialog", () => {
  const open = (ask: Partial<QuitStopAllAsk> = {}, onQuit = vi.fn(() => new Promise<never>(() => {}))) => {
    const onCancel = vi.fn();
    render(
      <QuitStopAllDialog
        ask={{ counts: { agents: 3, shells: 2 }, hostOn: true, ...ask }}
        onCancel={onCancel}
        onQuit={onQuit}
      />,
    );
    return { onCancel, onQuit };
  };
  const button = (name: string) => screen.getByRole("button", { name });

  it("names the agents it will stop and how many terminals there are", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Stop 3 running agents?" })).toBeTruthy();
    expect(screen.getByText("3 agents · 2 shells")).toBeTruthy();
    expect(screen.getByText("Their work stops mid-turn.")).toBeTruthy();
  });

  it("says Quit only keeps terminals for the linger, and that some are from an earlier launch", () => {
    open({ lingerSecs: 7200, background: 2 });
    expect(screen.getByText("Quit only keeps terminals running for 2 hours.")).toBeTruthy();
    expect(screen.getByText(/2 of these are still running in the background/)).toBeTruthy();
  });

  it("does not mention the linger when the host is off", () => {
    open({ hostOn: false, lingerSecs: 7200 });
    expect(screen.queryByText(/keeps terminals running/)).toBeNull();
  });

  it("Stop all stops everything", () => {
    const { onQuit, onCancel } = open();
    fireEvent.click(button("Stop all"));
    expect(onQuit).toHaveBeenCalledWith(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Quit only is the normal quit, which leaves hosted terminals running", () => {
    const { onQuit } = open();
    fireEvent.click(button("Quit only"));
    expect(onQuit).toHaveBeenCalledWith(false);
  });

  it("has no Quit only with the host off, where Quit stops everything anyway", () => {
    const { onQuit } = open({ hostOn: false });
    expect(screen.queryByRole("button", { name: "Quit only" })).toBeNull();
    expect(button("Cancel")).toBeTruthy();
    fireEvent.click(button("Stop all"));
    expect(onQuit).toHaveBeenCalledWith(true);
  });

  it("Cancel quits nothing", () => {
    const { onQuit, onCancel } = open();
    fireEvent.click(button("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("Stop all is the default: it holds focus and Enter fires it", () => {
    const { onQuit } = open();
    expect(document.activeElement).toBe(button("Stop all"));
    // Enter with focus outside a button goes to the primary action.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onQuit).toHaveBeenCalledWith(true);
  });

  it("Esc cancels", () => {
    const { onQuit, onCancel } = open();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("stays open and shows the error when stopping fails, and can be tried again", async () => {
    const onQuit = vi.fn(() => Promise.reject("Could not reach the terminal host: timed out"));
    const { onCancel } = open({}, onQuit);
    fireEvent.click(button("Stop all"));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Could not reach the terminal host: timed out");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
    expect((button("Stop all") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button("Stop all"));
    expect(onQuit).toHaveBeenCalledTimes(2);
  });

  it("ignores more presses while a stop is in flight", () => {
    const { onQuit, onCancel } = open();
    fireEvent.click(button("Stop all"));
    expect((button("Stop all") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Quit only") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button("Quit only"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("opens straight into the error when stopping failed with no agent running", () => {
    open({ counts: { agents: 0, shells: 1 }, error: "Could not reach the terminal host: timed out" });
    expect(screen.getByRole("dialog", { name: "Stop all terminals?" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("terminal host");
  });
});

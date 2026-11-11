import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentHint } from "../ipc";
import {
  countTerminals,
  startQuitStopAll,
  stopAllMeta,
  stopAllTitle,
  type TerminalCounts,
} from "../quitStopAll";
import { QuitStopAllDialog } from "./QuitStopAllDialog";

const agent = (bin: string): { agent_hint: AgentHint } => ({
  agent_hint: { bin, pkg: null, path: `/usr/local/bin/${bin}`, interactive: true },
});
const shell = { agent_hint: null };

afterEach(() => cleanup());

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
    expect(stopAllMeta({ agents: 3, shells: 2 })).toBe("3 agents · 2 shells");
    expect(stopAllMeta({ agents: 1, shells: 1 })).toBe("1 agent · 1 shell");
    expect(stopAllMeta({ agents: 2, shells: 0 })).toBe("2 agents");
  });
});

describe("Quit and Stop All", () => {
  it("stops everything and quits at once when no agent is running", async () => {
    const quit = vi.fn();
    const ask = vi.fn();
    await startQuitStopAll({ stats: async () => [shell, shell], quit, ask });
    expect(quit).toHaveBeenCalledWith(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("quits with no terminals at all", async () => {
    const quit = vi.fn();
    const ask = vi.fn();
    await startQuitStopAll({ stats: async () => [], quit, ask });
    expect(quit).toHaveBeenCalledWith(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks first when agents are running, and does not quit yet", async () => {
    const quit = vi.fn();
    const ask = vi.fn();
    await startQuitStopAll({ stats: async () => [agent("claude"), agent("codex"), shell], quit, ask });
    expect(ask).toHaveBeenCalledWith({ agents: 2, shells: 1 });
    expect(quit).not.toHaveBeenCalled();
  });

  it("does nothing when the terminals cannot be read, rather than stop blind", async () => {
    const quit = vi.fn();
    const ask = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await startQuitStopAll({ stats: () => Promise.reject(new Error("gone")), quit, ask });
    expect(quit).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the dialog", () => {
  const counts: TerminalCounts = { agents: 3, shells: 2 };
  const open = () => {
    const onCancel = vi.fn();
    const onQuit = vi.fn();
    render(<QuitStopAllDialog counts={counts} onCancel={onCancel} onQuit={onQuit} />);
    return { onCancel, onQuit };
  };

  it("names the agents it will stop and how many terminals there are", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Stop 3 running agents?" })).toBeTruthy();
    expect(screen.getByText("3 agents · 2 shells")).toBeTruthy();
    expect(screen.getByText("Their work stops mid-turn.")).toBeTruthy();
  });

  it("Stop all stops everything", () => {
    const { onQuit, onCancel } = open();
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    expect(onQuit).toHaveBeenCalledWith(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Quit only is the normal quit, which leaves hosted terminals running", () => {
    const { onQuit } = open();
    fireEvent.click(screen.getByRole("button", { name: "Quit only" }));
    expect(onQuit).toHaveBeenCalledWith(false);
  });

  it("Cancel quits nothing", () => {
    const { onQuit, onCancel } = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("Stop all is the default: it holds focus and Enter fires it", () => {
    const { onQuit } = open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop all" }));
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
});

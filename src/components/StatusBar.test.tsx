import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import * as ipc from "../ipc";
import { modelSwitchFor } from "../agentModels";
import type { AgentEventEntry } from "../types";

vi.mock("../ipc", () => ({
  gitStatus: vi.fn(),
  claudeSessionStats: vi.fn(),
  onAppStats: vi.fn(),
  onPtyStats: vi.fn(),
  agentUsage: vi.fn(),
}));

const noSub = async () => () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.gitStatus).mockResolvedValue({
    is_repo: true,
    branch: "main",
    entries: [],
  } as never);
  vi.mocked(ipc.onAppStats).mockImplementation(noSub as never);
  vi.mocked(ipc.onPtyStats).mockImplementation(noSub as never);
  vi.mocked(ipc.agentUsage).mockResolvedValue([]);
  vi.mocked(ipc.claudeSessionStats).mockResolvedValue({
    model: "claude-opus-5",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 1,
  } as never);
});

const claudeEvent = (pty: number): AgentEventEntry =>
  ({
    id: `e${pty}`,
    at: 0,
    data: {
      cwd: "/repo",
      pty,
      transcriptPath: `/t/${pty}.jsonl`,
      hook_event_name: "Stop",
    },
  }) as unknown as AgentEventEntry;

const base = {
  roots: ["/repo"],
  agents: [],
  visible: true,
  projects: [{ name: "canopy", roots: ["/repo"] }],
};

describe("the tray's model control", () => {
  it("lists the models of an inline CLI and switches to the one clicked", async () => {
    const onSetModel = vi.fn();
    render(
      <StatusBar
        {...base}
        events={[claudeEvent(7)]}
        activePtyId={7}
        onSetModel={onSetModel}
        modelSwitch={modelSwitchFor("claude")}
        agentLabel="Claude Code"
      />,
    );
    fireEvent.click(await screen.findByText(/opus-5 ▾/));
    fireEvent.click(screen.getByText("Sonnet · 1M context"));
    // The confirmation names the exact line that will be typed — a picker's
    // command with a model appended would be the bug this spells out.
    expect(screen.getByText("/model sonnet[1m]")).toBeTruthy();
    fireEvent.click(screen.getByText("Switch model"));
    expect(onSetModel).toHaveBeenCalledWith("sonnet[1m]");
  });

  it("opens a picker CLI's own chooser instead of naming models for it", () => {
    const onSetModel = vi.fn();
    render(
      <StatusBar
        {...base}
        events={[]}
        activePtyId={9}
        onSetModel={onSetModel}
        modelSwitch={modelSwitchFor("codex")}
        agentLabel="Codex CLI"
      />,
    );
    // No transcript for Codex, so no model name to show — the button names the
    // action instead of borrowing a model it doesn't know.
    fireEvent.click(screen.getByText("model ▾"));
    expect(screen.getByText("/model")).toBeTruthy();
    expect(screen.queryByText("Sonnet")).toBeNull();
    fireEvent.click(screen.getByText("Open picker"));
    expect(onSetModel).toHaveBeenCalledWith(undefined);
  });

  it("offers nothing for a CLI whose model command is unverified", () => {
    render(
      <StatusBar
        {...base}
        events={[]}
        activePtyId={9}
        onSetModel={vi.fn()}
        modelSwitch={modelSwitchFor("amp")}
      />,
    );
    expect(screen.queryByText("model ▾")).toBeNull();
  });

  it("shows no session numbers on a terminal that has no transcript", async () => {
    // The pty in front (9) never spoke; another session in the project did.
    // Borrowing its transcript is how a Codex tab came to report Claude's
    // model and Claude's token count.
    render(
      <StatusBar
        {...base}
        events={[claudeEvent(7)]}
        activePtyId={9}
        modelSwitch={null}
      />,
    );
    expect(screen.queryByText(/opus-5/)).toBeNull();
    // Not merely unrendered — the other session's transcript is never even read.
    expect(ipc.claudeSessionStats).not.toHaveBeenCalled();
  });

  it("still falls back project-wide when no event carries a pty", async () => {
    const unstamped = {
      id: "u",
      at: 0,
      data: { cwd: "/repo", transcriptPath: "/t/u.jsonl" },
    } as unknown as AgentEventEntry;
    render(
      <StatusBar {...base} events={[unstamped]} activePtyId={9} modelSwitch={null} />,
    );
    expect(await screen.findByText(/opus-5/)).toBeTruthy();
  });
});

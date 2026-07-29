import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { BranchSwitchProvider } from "../useBranchSwitch";
import * as ipc from "../ipc";
import { modelSwitchFor } from "../agentModels";
import type { AgentEventEntry } from "../types";

vi.mock("../ipc", () => ({
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitCheckout: vi.fn(),
  claudeSessionStats: vi.fn(),
  onAppStats: vi.fn(),
  onPtyStats: vi.fn(),
  agentUsage: vi.fn(),
  planUsage: vi.fn(),
}));

const noSub = async () => () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.gitStatus).mockResolvedValue({
    is_repo: true,
    branch: "main",
    entries: [],
  } as never);
  vi.mocked(ipc.gitBranches).mockResolvedValue([
    { name: "main", current: true, remote_only: false } as never,
    { name: "feat/x", current: false, remote_only: false } as never,
  ]);
  vi.mocked(ipc.gitCheckout).mockResolvedValue({
    kind: "switched",
    message: "Switched to feat/x",
    path: null,
  } as never);
  vi.mocked(ipc.onAppStats).mockImplementation(noSub as never);
  vi.mocked(ipc.onPtyStats).mockImplementation(noSub as never);
  vi.mocked(ipc.agentUsage).mockResolvedValue([]);
  vi.mocked(ipc.planUsage).mockResolvedValue([]);
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

describe("the tray's plan chip", () => {
  const claudePlan = {
    agent: "claude",
    plan: "default_claude_max_20x",
    windows: [
      { label: "5h", used_percent: 18, resets_at: null },
      { label: "7d", used_percent: 52, resets_at: null },
    ],
    credits: null,
    observed: Math.floor(Date.now() / 1000),
  };

  it("shows the headroom of the CLI in front", async () => {
    vi.mocked(ipc.planUsage).mockResolvedValue([claudePlan] as never);
    render(<StatusBar {...base} events={[]} agentId="claude" />);
    expect(await screen.findByText("7d 52% · 5h 18%")).toBeTruthy();
  });

  // The important negative: a chip belonging to another CLI is worse than no
  // chip, because it looks authoritative.
  it("shows nothing for a CLI that reports no plan", async () => {
    vi.mocked(ipc.planUsage).mockResolvedValue([claudePlan] as never);
    render(<StatusBar {...base} events={[]} agentId="amp" />);
    await screen.findByText(/main/);
    expect(screen.queryByText(/52%/)).toBeNull();
  });

  it("escalates once a window is nearly spent", async () => {
    vi.mocked(ipc.planUsage).mockResolvedValue([
      { ...claudePlan, windows: [{ label: "7d", used_percent: 96, resets_at: null }] },
    ] as never);
    render(<StatusBar {...base} events={[]} agentId="claude" />);
    const chip = await screen.findByText("7d 96%");
    expect(chip.className).toContain("is-critical");
  });
});

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

// The most persistently visible branch affordance in the app. It used to be an
// inert span reading "git branch (N changed files)" — a git noun in primary
// chrome, and a detached HEAD rendered as a branch literally called "HEAD".
describe("the tray's branch chip", () => {
  const inProvider = (ui: React.ReactElement) =>
    render(
      <BranchSwitchProvider onNotice={vi.fn()} onUseWorktree={vi.fn()}>
        {ui}
      </BranchSwitchProvider>,
    );

  it("switches through the one funnel when a branch is picked", async () => {
    inProvider(<StatusBar {...base} events={[]} modelSwitch={null} />);
    fireEvent.click(await screen.findByText(/⎇ main/));
    // Only somewhere else to go is offered — the branch you're on is the chip.
    expect(screen.queryByText("main")).toBeNull();
    fireEvent.click(screen.getByText("feat/x"));
    expect(ipc.gitCheckout).toHaveBeenCalledWith("/repo", "feat/x", false);
  });

  it("says what it means without a git noun", async () => {
    render(<StatusBar {...base} events={[]} modelSwitch={null} />);
    const chip = await screen.findByText(/⎇ main/);
    const tip = chip.getAttribute("title") ?? "";
    expect(tip).toBe("On main · 0 changed files. Click to switch.");
    for (const noun of ["git", "worktree", "detached", "stash", "HEAD"])
      expect(tip.toLowerCase()).not.toContain(noun.toLowerCase());
  });

  it("reads a detached HEAD as a snapshot, with the way back in the menu", async () => {
    // `rev-parse --abbrev-ref HEAD` answers a literal "HEAD" off a branch. The
    // tray printed that as if it were a branch you could be on.
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "HEAD",
      entries: [{ status: " M", path: "/repo/a.ts" }],
    } as never);
    inProvider(<StatusBar {...base} events={[]} modelSwitch={null} />);
    const chip = await screen.findByText(/snapshot/);
    expect(chip.textContent).toContain("⚠ snapshot");
    expect(chip.getAttribute("title")).toBe(
      "You're looking at a snapshot of the code · 1 changed file. Click to go back.",
    );
    fireEvent.click(chip);
    // The same sentence the Git panel leads with, where the exit actually is.
    expect(
      screen.getByText(/Pick a branch to go back — nothing you had is lost/),
    ).toBeTruthy();
  });
});

// The tray is one line, and this is the only chip whose length is set by how
// much work is running. Twenty-five agents spelled out ran the width of the
// window and pushed the branch, the model and the cost off the bar.
describe("the running-agents chip", () => {
  const agents = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: i % 4 === 0 ? "codex" : "claude", cpu: 0 }));

  it("spells out a handful", async () => {
    render(<StatusBar {...base} agents={agents(3)} events={[]} />);
    const chip = await screen.findByTitle(/running agents/);
    expect(chip.textContent).toBe("codex, claude, claude");
    expect(chip.textContent).not.toContain("+");
  });

  it("counts the rest instead of listing them", async () => {
    render(<StatusBar {...base} agents={agents(25)} events={[]} />);
    const chip = await screen.findByTitle(/running agents/);
    expect(chip.textContent).toBe("codex, claude, claude+22");
  });

  it("keeps every name in the tooltip", async () => {
    render(<StatusBar {...base} agents={agents(25)} events={[]} />);
    const chip = await screen.findByTitle(/running agents/);
    expect(chip.getAttribute("title")?.split(", ")).toHaveLength(25);
  });

  it("says nothing when nothing is running", () => {
    render(<StatusBar {...base} agents={[]} events={[]} />);
    expect(screen.queryByTitle(/running agents/)).toBeNull();
  });
});

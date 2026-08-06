import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { BranchSwitchProvider } from "../useBranchSwitch";
import * as ipc from "../ipc";
import { modelSwitchFor } from "../agentModels";
import type { AgentEventEntry } from "../types";
import { getSettings } from "../settings";

vi.mock("../ipc", () => ({
  gitStatus: vi.fn(),
  onGitChange: vi.fn(),
  gitBranches: vi.fn(),
  gitCheckout: vi.fn(),
  claudeSessionStats: vi.fn(),
  opencodeSessionStats: vi.fn(),
  onAppStats: vi.fn(),
  onPtyStats: vi.fn(),
  agentUsage: vi.fn(),
  planUsage: vi.fn(),
  profilesList: vi.fn(),
  profileActivate: vi.fn(),
  profileAccounts: vi.fn(),
  gitSyncProbe: vi.fn(),
  gitSyncApply: vi.fn(),
  gitSyncAbort: vi.fn(),
}));

/** A branch sitting level with its base — the quiet default, so every test
 *  that isn't about drift sees no chip. */
const inSync = {
  repo: "/repo",
  branch: "main",
  base: "origin/main",
  base_head: "aaa111",
  behind: 0,
  ahead: 0,
  dirty: 0,
  state: "current",
  conflicts: [],
  overlap: [],
  subjects: [],
  blocked: null,
  fetch_error: null,
};

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
  vi.mocked(ipc.onGitChange).mockImplementation(noSub as never);
  vi.mocked(ipc.gitSyncProbe).mockResolvedValue(inSync as never);
  vi.mocked(ipc.onAppStats).mockImplementation(noSub as never);
  vi.mocked(ipc.onPtyStats).mockImplementation(noSub as never);
  vi.mocked(ipc.agentUsage).mockResolvedValue([]);
  vi.mocked(ipc.planUsage).mockResolvedValue([]);
  // One account is the normal machine: the switcher hides itself entirely
  // there, which is what every test below expects to see.
  vi.mocked(ipc.profilesList).mockResolvedValue([
    { id: "default", label: "Default", root: "/Users/dev", removable: false },
  ]);
  vi.mocked(ipc.profileAccounts).mockResolvedValue([]);
  vi.mocked(ipc.profileActivate).mockResolvedValue(undefined);
  vi.mocked(ipc.claudeSessionStats).mockResolvedValue({
    model: "claude-opus-5",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 1,
  } as never);
  vi.mocked(ipc.opencodeSessionStats).mockResolvedValue(null);
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

describe("the tray's base-branch chip", () => {
  const behind = {
    ...inSync,
    branch: "fix/login",
    behind: 4,
    ahead: 2,
    state: "clean",
    subjects: ["fix nav", "bump deps"],
  };

  it("stays out of the way while the branch is level with its base", async () => {
    render(<StatusBar {...base} events={[]} />);
    await screen.findByText(/main/);
    expect(screen.queryByText(/\+4/)).toBeNull();
  });

  it("raises the news by itself, and merges on the click", async () => {
    vi.mocked(ipc.gitSyncProbe).mockResolvedValue(behind as never);
    vi.mocked(ipc.gitSyncApply).mockResolvedValue({
      merged: true,
      conflicts: [],
      message: "Fast-forward",
    } as never);
    render(<StatusBar {...base} events={[]} />);

    // Opens itself: the whole point is not waiting for the user to go looking.
    expect(await screen.findByText("main has 4 new commits")).toBeTruthy();
    fireEvent.click(screen.getByText("Merge main in"));
    expect(ipc.gitSyncApply).toHaveBeenCalledWith("/repo", "origin/main");
  });

  it("names the conflicting files and promises nothing has changed yet", async () => {
    vi.mocked(ipc.gitSyncProbe).mockResolvedValue({
      ...behind,
      state: "conflict",
      conflicts: ["src/a.ts", "src/b.ts"],
    } as never);
    render(<StatusBar {...base} events={[]} />);

    expect(await screen.findByText("main has 4 new commits — 2 files would conflict")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText(/Nothing has been changed yet/)).toBeTruthy();
    // Offered, not forced — and nothing ran just from looking.
    expect(screen.getByText("Merge and resolve now")).toBeTruthy();
    expect(ipc.gitSyncApply).not.toHaveBeenCalled();
  });

  it("won't merge over uncommitted work, and says which file is in the way", async () => {
    vi.mocked(ipc.gitSyncProbe).mockResolvedValue({
      ...behind,
      dirty: 2,
      overlap: ["src/a.ts"],
    } as never);
    render(<StatusBar {...base} events={[]} />);

    const btn = (await screen.findByText("Merge main")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Commit or stash it/)).toBeTruthy();
  });

  it("takes 'keep working' for an answer until the base moves again", async () => {
    vi.mocked(ipc.gitSyncProbe).mockResolvedValue(behind as never);
    const { rerender } = render(<StatusBar {...base} events={[]} />);

    fireEvent.click(await screen.findByText("Keep working"));
    expect(screen.queryByText("main has 4 new commits")).toBeNull();
    // The chip itself stays: dismissing hides the panel, not the fact.
    expect(screen.getByText(/main \+4/)).toBeTruthy();

    // A re-probe of the same tip must not pop back up.
    rerender(<StatusBar {...base} events={[]} />);
    expect(screen.queryByText("main has 4 new commits")).toBeNull();
  });
});

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
    fireEvent.click(screen.getByText("Fable"));
    // The confirmation names the exact line that will be typed — a picker's
    // command with a model appended would be the bug this spells out.
    expect(screen.getByText("/model fable")).toBeTruthy();
    fireEvent.click(screen.getByText("Switch model"));
    expect(onSetModel).toHaveBeenCalledWith("fable");
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

  it("shows the active OpenCode model reported by its turn-start hook", () => {
    const event = {
      ts: 1,
      data: {
        sessionId: "ses_1",
        cwd: "/repo",
        pty: 9,
        event: "UserPromptSubmit",
        tool: "",
        agent: "opencode",
        model: "azure/gpt-5.6-sol",
      },
    } satisfies AgentEventEntry;
    render(
      <StatusBar
        {...base}
        events={[event]}
        activePtyId={9}
        onSetModel={vi.fn()}
        modelSwitch={modelSwitchFor("opencode")}
        agentLabel="OpenCode"
      />,
    );
    expect(screen.getByText("gpt-5.6-sol ▾")).toBeTruthy();
    expect(screen.queryByText("model ▾")).toBeNull();
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

// An opencode terminal has no transcript to poll, so the tray used to show no
// tokens and no cost at all — while opencode's own status line displayed both.
// Its numbers come off the session row in opencode's store instead, billed
// cost included, which for a custom provider (Azure) is the only cost there is.
describe("the tray's numbers for a store-backed CLI", () => {
  const ocEvent = (sessionId: string, pty = 9): AgentEventEntry =>
    ({
      ts: 1,
      data: {
        sessionId,
        cwd: "/tmp/scratch-worktree", // deliberately outside the project roots
        pty,
        event: "Stop",
        tool: "",
        agent: "opencode",
      },
    }) satisfies AgentEventEntry;

  it("shows the store's tokens and the CLI's own billed cost, unhedged", async () => {
    vi.mocked(ipc.opencodeSessionStats).mockResolvedValue({
      model: "gpt-5.6-sol",
      input_tokens: 369,
      output_tokens: 64310,
      cache_read_tokens: 2500000,
      cache_creation_tokens: 0,
      turns: 130,
      cost: 19.31,
    });
    render(
      <StatusBar {...base} events={[ocEvent("ses_billed")]} activePtyId={9} modelSwitch={null} />,
    );
    const chip = await screen.findByText("$19.31");
    // Billed, not estimated: no "~", and the tooltip says whose figure it is.
    expect(chip.textContent).not.toContain("~");
    expect(chip.getAttribute("title")).toBe("session cost, as billed by the CLI");
    expect(screen.getByTitle(/130 turns/)).toBeTruthy();
    expect(ipc.opencodeSessionStats).toHaveBeenCalledWith("ses_billed");
    // No transcript was ever guessed at for it.
    expect(ipc.claudeSessionStats).not.toHaveBeenCalled();
  });

  it("falls back to the price-table estimate when the store has no cost", async () => {
    // A subscription-billed model: opencode records 0, the reader sends null.
    vi.mocked(ipc.opencodeSessionStats).mockResolvedValue({
      model: "gpt-5.6-sol",
      input_tokens: 1000000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: 3,
      cost: null,
    });
    render(
      <StatusBar {...base} events={[ocEvent("ses_free")]} activePtyId={9} modelSwitch={null} />,
    );
    // $5/MTok input for the gpt-5.6 family, hedged as every estimate is.
    const chip = await screen.findByText("~$5.00");
    expect(chip.getAttribute("title")).toBe("estimated session cost");
  });

  it("never reads the store for a terminal that isn't opencode's", async () => {
    render(
      <StatusBar {...base} events={[claudeEvent(7)]} activePtyId={9} modelSwitch={null} />,
    );
    await screen.findByText(/main/);
    expect(ipc.opencodeSessionStats).not.toHaveBeenCalled();
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

  it("keeps a short list plain — no box to read past on a small repo", async () => {
    inProvider(<StatusBar {...base} events={[]} modelSwitch={null} />);
    fireEvent.click(await screen.findByText(/⎇ main/));
    expect(screen.queryByPlaceholderText("Search branches…")).toBeNull();
  });

  // The tray used to offer twelve branches and then a dim row reading "140 more
  // in the Git panel" — a count of what it was refusing to show, and a panel to
  // go open instead. Every branch is in the menu now, behind a search box.
  it("reaches a branch far past the preview, without leaving the tray", async () => {
    vi.mocked(ipc.gitBranches).mockResolvedValue([
      { name: "main", current: true, remote_only: false } as never,
      ...Array.from(
        { length: 152 },
        (_, i) => ({ name: `fix/thing-${i}`, current: false, remote_only: false }) as never,
      ),
    ]);
    inProvider(<StatusBar {...base} events={[]} modelSwitch={null} />);
    fireEvent.click(await screen.findByText(/⎇ main/));
    // Not a wall of 152 rows: the shortcut is still the shortcut.
    expect(screen.queryByText("fix/thing-140")).toBeNull();
    expect(screen.getByText("140 more branches — type to search")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search branches…"), {
      target: { value: "thing-140" },
    });
    fireEvent.click(screen.getByText("fix/thing-140"));
    expect(ipc.gitCheckout).toHaveBeenCalledWith("/repo", "fix/thing-140", false);
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

describe("the account switcher", () => {
  const twoAccounts = [
    { id: "default", label: "Default", root: "/Users/dev", removable: false },
    { id: "vj", label: "VJ", root: "/Users/dev/.canopy/profiles/vj", removable: true },
  ];

  beforeEach(() => localStorage.clear());

  it("hides itself entirely until a second account exists", async () => {
    render(<StatusBar {...base} events={[]} />);
    await screen.findByText(/main/);
    expect(screen.queryByTitle(/click to switch/)).toBeNull();
  });

  it("names the account new agents launch as", async () => {
    vi.mocked(ipc.profilesList).mockResolvedValue(twoAccounts as never);
    render(<StatusBar {...base} events={[]} />);
    expect(await screen.findByTitle(/New agents launch as Default/)).toBeTruthy();
  });

  /** .status-bar clips its row, so an absolutely positioned menu renders
   *  behind the page. Every other popup here is fixed. */
  it("escapes the status bar's clipping instead of opening behind it", async () => {
    vi.mocked(ipc.profilesList).mockResolvedValue(twoAccounts as never);
    render(<StatusBar {...base} events={[]} />);
    fireEvent.click(await screen.findByTitle(/New agents launch as Default/));
    const menu = document.querySelector(".status-account-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.position).toBe("fixed");
  });

  it("switches every CLI at once, and the chip follows", async () => {
    vi.mocked(ipc.profilesList).mockResolvedValue(twoAccounts as never);
    render(<StatusBar {...base} events={[]} />);
    fireEvent.click(await screen.findByTitle(/New agents launch as Default/));
    fireEvent.click(await screen.findByText("VJ"));
    expect(await screen.findByTitle(/New agents launch as VJ/)).toBeTruthy();
    expect(getSettings().activeProfile).toBe("vj");
  });

  it("says which CLIs an account can actually launch", async () => {
    vi.mocked(ipc.profilesList).mockResolvedValue(twoAccounts as never);
    vi.mocked(ipc.profileAccounts).mockImplementation(async (id: string) =>
      id === "vj"
        ? ([
            { agent: "claude", state: "in", account: "vj@example.com" },
            { agent: "codex", state: "out", account: null },
          ] as never)
        : ([] as never),
    );
    render(<StatusBar {...base} events={[]} />);
    fireEvent.click(await screen.findByTitle(/New agents launch as Default/));
    expect(await screen.findByText("claude")).toBeTruthy();
  });
});

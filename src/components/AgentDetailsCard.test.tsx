import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  fsReadFile: vi.fn(async (path: string) =>
    new TextEncoder().encode(
      path.endsWith(".md") ? "# Risk report\nThe store policy changed." : "x",
    ),
  ),
  gitPrContext: vi.fn(async () => ({ commit_count: 0 })),
  gitStatus: vi.fn(async () => ({
    is_repo: true,
    branch: "feat/x",
    entries: [{}, {}, {}],
  })),
  ghPrMerge: vi.fn(async () => ({ message: "Merged #21", pending: false })),
  ghPrClose: vi.fn(async () => "closed"),
  ghPrList: vi.fn(async () => [
    {
      number: 12,
      title: "Add thing",
      branch: "feat/x",
      state: "OPEN",
      draft: false,
      checks: "PASS",
      mergeable: "MERGEABLE",
      review_decision: "",
      additions: 40,
      deletions: 3,
    },
  ]),
}));
vi.mock("../links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../links")>()),
  openInOsBrowser: vi.fn(),
}));
vi.mock("../commitPushPrIpc", () => ({
  runCommitPushPr: vi.fn(async () => ({
    committed: true,
    pushed: true,
    prUrl: "https://x/pr/9",
    prExisted: false,
    skipped: [],
  })),
}));
vi.mock("../sessionActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessionActivity")>()),
  useSessionActivity: () => ({
    subagents: [
      {
        id: "a",
        agent_id: null,
        description: "semantic_reviewer",
        kind: null,
        status: "running",
        background: true,
        started_ms: Date.now() - 300_000,
        ended_ms: null,
        duration_ms: null,
        tokens: null,
        tool_uses: null,
        result: null,
      },
      {
        id: "b",
        agent_id: null,
        description: "planner",
        kind: null,
        status: "done",
        background: false,
        started_ms: 1,
        ended_ms: 5,
        duration_ms: 4000,
        tokens: null,
        tool_uses: null,
        result: null,
      },
      {
        id: "c",
        agent_id: null,
        description: "broken one",
        kind: null,
        status: "failed",
        background: false,
        started_ms: 1,
        ended_ms: 5,
        duration_ms: 1000,
        tokens: null,
        tool_uses: null,
        result: null,
      },
    ],
    context: null,
    compactions: [],
  }),
}));
vi.mock("../remoteExecution/workspace", () => ({
  activeWorkspace: () => undefined,
}));

import { AgentDetailsCard, prStatusLabel } from "./AgentDetailsCard";
import { liveEnvironments } from "../environments/live";
import * as ipc from "../ipc";
import * as links from "../links";

const idle = { state: "idle" } as never;
const digest = {
  session_id: "s",
  subagents: 2,
  files: [
    "src/a.ts",
    "docs/risk report.md",
    "hero.png",
    "/tmp/scratch/page.html",
  ],
  tasks: [
    { text: "Write the parser", status: "completed" },
    { text: "Wire it up", status: "running" },
    { text: "Ship", status: "pending" },
  ],
};

function setup(extra: Partial<Parameters<typeof AgentDetailsCard>[0]> = {}) {
  const onSendToAgent = vi.fn();
  const onOpenWorkspace = vi.fn();
  render(
    <AgentDetailsCard
      agent="claude"
      repo="/r"
      cwd="/r"
      digest={digest}
      life={idle}
      onOpenWorkspace={onOpenWorkspace}
      onSendToAgent={onSendToAgent}
      {...extra}
    />,
  );
  return { onSendToAgent, onOpenWorkspace };
}

beforeEach(() => localStorage.clear());

describe("AgentDetailsCard on another machine", () => {
  it("reads branch and changes from that machine and does not look up a PR from this Mac", async () => {
    const invoke = vi.fn(async () => ({
      is_repo: true,
      branch: "agent/claude-x",
      entries: [{}],
    }));
    liveEnvironments.register(
      {
        id: "remote:w1",
        name: "Coraa Workstation",
        host: { invoke } as never,
        status: "connected",
        readOnly: false,
      },
      { secondary: true },
    );
    vi.mocked(ipc.gitStatus).mockClear();
    vi.mocked(ipc.ghPrList).mockClear();
    setup({
      machine: { env: "remote:w1", name: "Coraa Workstation" },
      repo: undefined,
      cwd: "/w/app-wt-agent",
    });
    expect(screen.getByText("Coraa Workstation")).toBeInTheDocument();
    expect(await screen.findByText("agent/claude-x")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("git_status", {
      path: "/w/app-wt-agent",
    });
    expect(ipc.gitStatus).not.toHaveBeenCalled();
    expect(ipc.ghPrList).not.toHaveBeenCalled();
    liveEnvironments.unregister("remote:w1");
  });
});

describe("file assets of an agent on another machine", () => {
  it("opens read-only through that machine, not through this window's file tabs", async () => {
    const invoke = vi.fn(async (command: string) =>
      command === "git_status"
        ? { is_repo: true, branch: "agent/x", entries: [] }
        : { b64: "" },
    );
    liveEnvironments.register(
      {
        id: "remote:w1",
        name: "Coraa Workstation",
        host: { invoke } as never,
        status: "connected",
        readOnly: false,
      },
      { secondary: true },
    );
    const seen = vi.fn();
    window.addEventListener("canopy:open-remote-file", seen);
    const onOpenAsset = vi.fn();
    setup({
      machine: { env: "remote:w1", name: "Coraa Workstation" },
      repo: undefined,
      cwd: "/w/app",
      onOpenAsset,
    });
    fireEvent.click(screen.getByRole("button", { name: /Assets/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /risk report\.md/ }),
    );
    expect(onOpenAsset).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      env: "remote:w1",
      machine: "Coraa Workstation",
      path: "/w/app/docs/risk report.md",
    });
    window.removeEventListener("canopy:open-remote-file", seen);
    liveEnvironments.unregister("remote:w1");
  });
});

describe("AgentDetailsCard", () => {
  it("shows machine, branch, PR, changes, subagents and a task summary", async () => {
    setup();
    expect(screen.getByText("This Mac")).toBeInTheDocument();
    expect(await screen.findByText("feat/x")).toBeInTheDocument();
    expect(await screen.findByText("#12")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("+40")).toBeInTheDocument();
    expect(screen.getByText("Lineage · 1 running")).toBeInTheDocument();
    expect(screen.getByText("1 done · 2 pending")).toBeInTheDocument();
    expect(screen.getByText("Wire it up")).toBeInTheDocument(); // current step while collapsed
  });

  it("expands the task list and sends focus and complete requests to the agent", async () => {
    const { onSendToAgent } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.getByText("Write the parser")).toBeInTheDocument();
    expect(screen.queryByLabelText("Focus on Write the parser")).toBeNull(); // done tasks have no actions
    fireEvent.click(screen.getByLabelText("Focus on Ship"));
    expect(onSendToAgent).toHaveBeenLastCalledWith(
      expect.stringContaining("Ship"),
    );
    fireEvent.click(screen.getByLabelText("Complete Wire it up"));
    expect(onSendToAgent).toHaveBeenLastCalledWith(
      expect.stringContaining("Wire it up"),
    );
    fireEvent.click(screen.getByLabelText("Run Ship as a sub agent"));
    expect(onSendToAgent).toHaveBeenLastCalledWith(
      expect.stringMatching(/sub agent.*Ship/),
    );
    expect(
      screen.queryByLabelText("Run Write the parser as a sub agent"),
    ).toBeNull();
  });

  it("removes a task from the list with the x, and keeps it removed", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(screen.getByLabelText("Remove Ship"));
    expect(screen.queryByText("Ship")).toBeNull();
    expect(screen.getByText("Write the parser")).toBeInTheDocument();
  });

  it("will not type into an agent that is waiting for an answer or has ended", () => {
    const waiting = setup({ life: { state: "waiting" } as never });
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.getByLabelText("Focus on Ship")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Focus on Ship"));
    expect(waiting.onSendToAgent).not.toHaveBeenCalled();
  });

  it("says why when the message was not delivered", async () => {
    const onNotice = vi.fn();
    const onSendToAgent = vi.fn(async () => ({
      delivered: false,
      note: "No live terminal.",
    }));
    render(
      <AgentDetailsCard
        agent="claude"
        repo="/r"
        cwd="/r"
        digest={digest}
        life={idle}
        onOpenWorkspace={() => {}}
        onSendToAgent={onSendToAgent}
        onNotice={onNotice}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(screen.getByLabelText("Focus on Ship"));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("No live terminal."),
    );
  });

  it("says there are no tasks and keeps the row inert", () => {
    setup({ digest: { session_id: "s" } });
    expect(screen.getByText("No tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tasks/ })).toBeDisabled();
  });

  it("lists running sub-agents with their age and keeps the finished ones behind a row", () => {
    setup();
    expect(screen.getByText("Lineage · 1 running")).toBeInTheDocument();
    expect(screen.getByText("semantic_reviewer")).toBeInTheDocument();
    expect(screen.queryByText("planner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Previous agents/ }));
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("broken one")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });

  it("lists the assets the agent made, shows a preview on hover, and opens one in a tab on click", async () => {
    const onOpenAsset = vi.fn();
    setup({ onOpenAsset });
    expect(screen.getByRole("button", { name: /Assets/ })).toHaveTextContent(
      "3 made",
    );
    expect(screen.queryByText("risk report.md")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Assets/ }));
    expect(
      screen
        .getAllByRole("button", { name: /\.(md|png|html)$/ })
        .map((b) => b.textContent),
    ).toEqual(["htmlpage.html", "imagehero.png", "markdownrisk report.md"]);
    fireEvent.mouseEnter(screen.getByTitle("/r/docs/risk report.md"));
    expect(
      await screen.findByRole("tooltip", { name: "Preview of risk report.md" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/The store policy changed/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /risk report\.md/ }));
    expect(onOpenAsset).toHaveBeenCalledWith("/r/docs/risk report.md", {
      system: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /hero\.png/ }), {
      metaKey: true,
    });
    expect(onOpenAsset).toHaveBeenLastCalledWith("/r/hero.png", {
      system: true,
    });
  });

  it("shows a running server in its own section and opens it on click", () => {
    const onOpenAsset = vi.fn();
    setup({ onOpenAsset, ports: [5173], digest: { session_id: "s" } });
    expect(screen.queryByRole("button", { name: /Assets/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open localhost:5173" }),
    );
    expect(onOpenAsset).toHaveBeenCalledWith("http://localhost:5173", {
      system: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open localhost:5173" }),
      { metaKey: true },
    );
    expect(onOpenAsset).toHaveBeenLastCalledWith("http://localhost:5173", {
      system: true,
    });
  });

  it("shows task progress as a bar", () => {
    setup({
      digest: {
        session_id: "s",
        tasks: [
          { text: "a", status: "completed" },
          { text: "b", status: "running" },
          { text: "c", status: "pending" },
        ],
      },
    });
    const bar = screen.getByRole("progressbar", { name: "Tasks done" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
  });

  it("offers to send the project to a workspace only when asked to, and calls back", () => {
    const onSendToWorkspace = vi.fn();
    setup({ onSendToWorkspace });
    fireEvent.click(screen.getByRole("button", { name: /To a workspace/ }));
    expect(onSendToWorkspace).toHaveBeenCalledOnce();
  });

  it("settles and unsettles the agent from the card", () => {
    const onSettle = vi.fn();
    const { rerender } = render(
      <AgentDetailsCard
        agent="claude"
        repo="/r"
        cwd="/r"
        digest={digest}
        life={idle}
        onOpenWorkspace={() => {}}
        onSendToAgent={() => {}}
        onSettle={onSettle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Settle/ }));
    expect(onSettle).toHaveBeenLastCalledWith(true);
    rerender(
      <AgentDetailsCard
        agent="claude"
        repo="/r"
        cwd="/r"
        digest={digest}
        life={idle}
        onOpenWorkspace={() => {}}
        onSendToAgent={() => {}}
        onSettle={onSettle}
        settled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Unsettle/ }));
    expect(onSettle).toHaveBeenLastCalledWith(false);
  });

  it("has no send row when the callback is absent", () => {
    setup();
    expect(screen.queryByRole("button", { name: /To a workspace/ })).toBeNull();
  });

  it("shows no Assets row when the agent has made none", () => {
    setup({ digest: { session_id: "s", files: ["src/a.ts"] } });
    expect(screen.queryByRole("button", { name: /Assets/ })).toBeNull();
  });

  it("opens the full workspace", () => {
    const { onOpenWorkspace } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Workspace/ }));
    expect(onOpenWorkspace).toHaveBeenCalled();
  });

  it("collapses to a pill with the task count and remembers it", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Hide agent details"));
    expect(screen.getByLabelText("Show agent details")).toHaveTextContent(
      "1/3",
    );
    expect(localStorage.getItem("canopy:agentCard:collapsed")).toBe("1");
    fireEvent.click(screen.getByLabelText("Show agent details"));
    await waitFor(() =>
      expect(screen.getByLabelText("Hide agent details")).toBeInTheDocument(),
    );
  });
});

describe("prStatusLabel", () => {
  const base = {
    state: "OPEN",
    draft: false,
    checks: "",
    mergeable: "",
    review_decision: "",
  } as never;
  it("ranks the states a person cares about", () => {
    expect(
      prStatusLabel({ ...(base as object), state: "MERGED" } as never),
    ).toBe("Merged");
    expect(prStatusLabel({ ...(base as object), draft: true } as never)).toBe(
      "Draft",
    );
    expect(
      prStatusLabel({ ...(base as object), checks: "FAIL" } as never),
    ).toBe("Checks failing");
    expect(
      prStatusLabel({ ...(base as object), mergeable: "CONFLICTING" } as never),
    ).toBe("Conflicts");
    expect(
      prStatusLabel({
        ...(base as object),
        review_decision: "APPROVED",
      } as never),
    ).toBe("Approved");
    expect(prStatusLabel(base)).toBe("Ready");
  });
});

describe("failing PR", () => {
  it("offers Fix it, which asks the agent to fix the checks", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "feat/x",
      entries: [],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 5,
        title: "Ship it",
        url: "u",
        branch: "feat/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "FAIL",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    const { onSendToAgent } = setup({ repo: "/failing", cwd: "/failing" });
    fireEvent.click(await screen.findByRole("button", { name: "Fix it" }));
    expect(onSendToAgent).toHaveBeenCalledWith(
      expect.stringContaining("failing checks"),
    );
  });
});

describe("PRs raised by the agent", () => {
  it("lists every one on hover", async () => {
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 7,
        title: "First",
        url: "u7",
        branch: "feat/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "PASS",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
      {
        number: 8,
        title: "Second",
        url: "u8",
        branch: "feat/y",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "FAIL",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    (ipc as unknown as { provenanceForSession: unknown }).provenanceForSession =
      vi.fn(async () => [
        {
          repo: "/many",
          pr_number: 8,
          pr_url: "u8",
          branch: "feat/y",
          session_id: "s",
        },
      ]);
    setup({ repo: "/many", cwd: "/many" });
    const row = (await screen.findByText("#7")).closest(
      ".agent-card-pr-row",
    ) as HTMLElement;
    fireEvent.mouseEnter(row);
    expect(
      screen.getByRole("list", { name: "Pull requests from this agent" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("#8").length).toBeGreaterThan(0);
    delete (ipc as unknown as { provenanceForSession?: unknown })
      .provenanceForSession;
  });
});

describe("lineage rows", () => {
  it("open to show what the sub-agent returned", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Previous agents/ }));
    fireEvent.click(screen.getByRole("button", { name: /planner/ }));
    expect(screen.getByText("No text was returned.")).toBeInTheDocument();
  });
});

describe("the PR number", () => {
  it("opens the pull request on GitHub", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "feat/x",
      entries: [],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 779,
        title: "All workspaces",
        url: "https://github.com/acme/app/pull/779",
        branch: "feat/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "PASS",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    setup({ repo: "/linkable", cwd: "/linkable" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open pull request #779 on GitHub",
      }),
    );
    expect(links.openInOsBrowser).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/779",
    );
  });
});

describe("merging from the card", () => {
  it("asks to confirm, then squash-merges the PR", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "feat/x",
      entries: [],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 21,
        title: "Ready",
        url: "u",
        branch: "feat/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "PASS",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    setup({ repo: "/mergeable", cwd: "/mergeable" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Squash & merge" }),
    );
    expect(ipc.ghPrMerge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(ipc.ghPrMerge).toHaveBeenCalledWith("/mergeable", 21, "squash"),
    );
    await waitFor(() => expect(screen.getByText("Merged")).toBeInTheDocument());
  });
  it("disables merging while checks fail", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "feat/x",
      entries: [],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 22,
        title: "Red",
        url: "u",
        branch: "feat/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "FAIL",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    setup({ repo: "/red", cwd: "/red" });
    expect(
      await screen.findByRole("button", { name: "Squash & merge" }),
    ).toBeDisabled();
  });
});

describe("raising a PR from the card", () => {
  it("offers Commit & raise PR for uncommitted work and runs the flow with the edited title", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "fix/hub-prefetch-scrcpy",
      entries: [{}, {}],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([] as never);
    const { onNotice } = setup({ repo: "/raise", cwd: "/raise" }) as {
      onNotice?: ReturnType<typeof vi.fn>;
    };
    fireEvent.click(
      await screen.findByRole("button", { name: "Commit & raise PR" }),
    );
    const input = screen.getByLabelText(
      "Pull request title",
    ) as HTMLInputElement;
    expect(input.value).toBe("Hub prefetch scrcpy");
    fireEvent.click(screen.getByRole("button", { name: "Raise PR" }));
    const { runCommitPushPr } = await import("../commitPushPrIpc");
    await waitFor(() =>
      expect(runCommitPushPr).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: "/raise",
          message: "Hub prefetch scrcpy",
          title: "Hub prefetch scrcpy",
        }),
      ),
    );
    void onNotice;
  });
  it("offers plain Raise PR when everything is committed but the branch is ahead", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "feat/ahead",
      entries: [],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([] as never);
    vi.mocked(ipc.gitPrContext).mockResolvedValue({ commit_count: 3 } as never);
    setup({ repo: "/ahead", cwd: "/ahead" });
    fireEvent.click(await screen.findByRole("button", { name: "Raise PR" }));
    fireEvent.click(await screen.findByRole("button", { name: "Raise PR" }));
    const { runCommitPushPr } = await import("../commitPushPrIpc");
    await waitFor(() =>
      expect(runCommitPushPr).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "/ahead", commit: false }),
      ),
    );
  });
});

describe("AgentDetailsCard docking", () => {
  it("is docked beside the terminal by default and says so, so the terminal can make room", () => {
    const onDockChange = vi.fn();
    setup({ onDockChange });
    expect(screen.getByLabelText("Agent details")).toHaveClass(
      "agent-card--docked",
    );
    expect(onDockChange).toHaveBeenLastCalledWith(true);
  });

  it("floats over the terminal when asked, remembers that, and gives the room back", () => {
    const onDockChange = vi.fn();
    setup({ onDockChange });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Float agent details over the terminal",
      }),
    );
    expect(screen.getByLabelText("Agent details")).not.toHaveClass(
      "agent-card--docked",
    );
    expect(onDockChange).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem("canopy:agentCard:docked")).toBe("0");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Dock agent details beside the terminal",
      }),
    );
    expect(onDockChange).toHaveBeenLastCalledWith(true);
  });

  it("takes no room while hidden to its pill", () => {
    const onDockChange = vi.fn();
    setup({ onDockChange });
    fireEvent.click(screen.getByRole("button", { name: "Hide agent details" }));
    expect(onDockChange).toHaveBeenLastCalledWith(false);
  });

  it("stays floating on the next mount once the person floated it", () => {
    localStorage.setItem("canopy:agentCard:docked", "0");
    const onDockChange = vi.fn();
    setup({ onDockChange });
    expect(screen.getByLabelText("Agent details")).not.toHaveClass(
      "agent-card--docked",
    );
    expect(onDockChange).not.toHaveBeenCalledWith(true);
  });
});

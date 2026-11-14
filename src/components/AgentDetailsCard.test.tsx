import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  // provenance.ts subscribes to the change channel at module load.
  onStoreChange: vi.fn(() => new Promise<never>(() => {})),
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
  ghPrAutoMerge: vi.fn(async () => "#21 will merge automatically once its checks and reviews pass"),
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
vi.mock("../prDraftBrain", () => ({
  draftPrWithBrain: vi.fn(async () => null),
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
// A call left over from an earlier test would satisfy the next test's "was
// called" wait before its own call lands.
beforeEach(async () => {
  const { runCommitPushPr } = await import("../commitPushPrIpc");
  vi.mocked(runCommitPushPr).mockClear();
});

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
    expect(screen.getByLabelText("1 done · 1 in progress · 1 not started")).toBeInTheDocument();
    // The current step is not repeated under the bar; it shows when the list opens.
    expect(screen.queryByText("Wire it up")).toBeNull();
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

  it("stops a server whose process is known, and offers no stop otherwise", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { onNotice } = setup({
      ports: [5173, 8080],
      onStopServer: { ports: [5173], stop },
      digest: { session_id: "s" },
    }) as { onNotice?: ReturnType<typeof vi.fn> };
    expect(screen.queryByRole("button", { name: "Stop localhost:8080" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop localhost:5173" }));
    expect(stop).toHaveBeenCalledWith(5173);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop localhost:5173" })).toBeDisabled(),
    );
    void onNotice;
  });

  it("offers Commit & push for uncommitted work on a branch that has its PR", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "fix/hub-prefetch-scrcpy",
      entries: [{}, {}, {}],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      { number: 77, title: "Hub prefetch", branch: "fix/hub-prefetch-scrcpy", base: "main", state: "OPEN", draft: false, additions: 4, deletions: 1, checks: "", url: "https://example.test/pr/77" },
    ] as never);
    setup({ repo: "/push", cwd: "/push" });
    fireEvent.click(await screen.findByRole("button", { name: "Commit & push" }));
    expect(screen.queryByRole("button", { name: /raise PR/i })).toBeNull();
    expect(screen.getByText("3 uncommitted")).toBeTruthy();
    const input = screen.getByLabelText("Commit message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Fix the retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    const { runCommitPushPr } = await import("../commitPushPrIpc");
    await waitFor(() =>
      expect(runCommitPushPr).toHaveBeenCalledWith({
        repo: "/push",
        message: "Fix the retry",
        commit: true,
        openPr: false,
      }),
    );
  });

  it("offers Commit & raise PR again once this branch's PR is merged", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "fix/hub-prefetch-scrcpy",
      entries: [{}, {}],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      { number: 79, title: "Hub prefetch", branch: "fix/hub-prefetch-scrcpy", base: "main", state: "MERGED", draft: false, additions: 4, deletions: 1, checks: "", url: "https://example.test/pr/79" },
    ] as never);
    setup({ repo: "/merged", cwd: "/merged" });
    await screen.findByRole("button", { name: "Commit & raise PR" });
    expect(screen.queryByRole("button", { name: "Commit & push" })).toBeNull();
  });

  it("does not offer Commit & push into a PR from another branch", async () => {
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "fix/other-work",
      entries: [{}],
    } as never);
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      { number: 78, title: "Elsewhere", branch: "fix/somewhere-else", base: "main", state: "OPEN", draft: false, additions: 1, deletions: 0, checks: "", url: "https://example.test/pr/78" },
    ] as never);
    setup({ repo: "/other", cwd: "/other" });
    await screen.findByRole("button", { name: "Commit & raise PR" });
    expect(screen.queryByRole("button", { name: "Commit & push" })).toBeNull();
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

  it("settles the agent from the card", () => {
    const onSettle = vi.fn();
    render(
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
    expect(onSettle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /^Unsettle/ })).toBeNull();
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

describe("checks still running", () => {
  it("shows checks only on hover, each with its state, failures first", async () => {
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 5,
        title: "Ship it",
        url: "u",
        branch: "feat/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "PENDING",
        checks_summary: "3/7 checks passed",
        check_runs: [
          { name: "Lint", state: "passed" },
          { name: "Frontend", state: "running" },
          { name: "Secret scan", state: "queued" },
          { name: "Rust", state: "failed" },
        ],
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    setup({ repo: "/pending-checks", cwd: "/pending-checks" });
    const badge = await screen.findByRole("button", { name: "1 of 4 checks passed" });
    expect(badge.textContent).toBe("1/4");
    expect(screen.queryByText("Frontend")).toBeNull();
    fireEvent.mouseEnter(badge.parentElement!);
    const list = () =>
      within(screen.getByRole("list", { name: "Checks" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent);
    expect(list()).toEqual(["RustFailed", "FrontendRunning", "Secret scanQueued", "1 passed"]);
    fireEvent.click(screen.getByRole("button", { name: "1 passed" }));
    expect(list()).toEqual(["RustFailed", "FrontendRunning", "Secret scanQueued", "LintPassed"]);
    vi.useFakeTimers();
    fireEvent.mouseLeave(badge.parentElement!);
    act(() => vi.advanceTimersByTime(200));
    vi.useRealTimers();
    expect(screen.queryByText("Frontend")).toBeNull();
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

describe("a PR from another branch", () => {
  it("shows the PR the session raised, and no Commit & raise PR", async () => {
    vi.mocked(ipc.ghPrList).mockResolvedValue([
      {
        number: 571,
        title: "Release: builder",
        url: "https://github.com/o/r/pull/571",
        branch: "release/x",
        base: "main",
        state: "OPEN",
        draft: false,
        checks: "PENDING",
        mergeable: "MERGEABLE",
        additions: 1,
        deletions: 0,
      },
    ] as never);
    (ipc as unknown as { provenanceForSession: unknown }).provenanceForSession =
      vi.fn(async () => [
        {
          repo: "/main-checkout",
          pr_number: 571,
          pr_url: "https://api.github.com/repos/o/r/pulls/571",
          branch: "release/x",
          session_id: "s",
        },
      ]);
    // Uncommitted work, so the raise button would show if nothing owned a PR.
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      is_repo: true,
      branch: "feat/x",
      entries: [{ status: "M", path: "a.ts" }],
    } as never);
    setup({ repo: "/wt-other", cwd: "/wt-other" });
    expect(await screen.findByText("#571")).toBeInTheDocument();
    expect(screen.queryByText(/Commit & raise PR/)).toBeNull();
    cleanup();
    // Control: the same session with no edge does offer it.
    (ipc as unknown as { provenanceForSession: unknown }).provenanceForSession =
      vi.fn(async () => []);
    setup({ repo: "/wt-control", cwd: "/wt-control" });
    expect(await screen.findByText(/Commit & raise PR/)).toBeInTheDocument();
    delete (ipc as unknown as { provenanceForSession?: unknown })
      .provenanceForSession;
  });
});

describe("the task list", () => {
  it("shows all three states in words, on one line", () => {
    setup();
    const legend = screen.getByLabelText("1 done · 1 in progress · 1 not started");
    expect(legend.getAttribute("title")).toBe("1 done · 1 in progress · 1 not started");
    expect(legend.textContent).toBe("111");
  });
  it("stays open when the card remounts", () => {
    try {
      localStorage.removeItem("canopy:agentCard:tasksOpen");
    } catch {
      /* no storage */
    }
    const first = setup();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.getAllByRole("button", { name: /Focus on/ })[0]).toBeInTheDocument();
    cleanup();
    setup();
    expect(screen.getAllByRole("button", { name: /Focus on/ })[0]).toBeInTheDocument();
    void first;
    localStorage.removeItem("canopy:agentCard:tasksOpen");
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
  it("offers Fix it instead of merging while checks fail", async () => {
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
    expect(await screen.findByRole("button", { name: "Fix it" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Squash & merge" })).toBeNull();
  });

  describe("when GitHub's branch policy refuses the merge", () => {
    const policy =
      "Pull request is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.";
    const open = async (repo: string) => {
      vi.mocked(ipc.ghPrAutoMerge).mockClear();
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
      setup({ repo, cwd: repo });
      fireEvent.click(
        await screen.findByRole("button", { name: "Squash & merge" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    };

    it("offers Merge when checks pass, and asks GitHub for auto-merge only when clicked", async () => {
      vi.mocked(ipc.ghPrMerge).mockRejectedValueOnce(new Error(policy));
      await open("/policy");
      const offer = await screen.findByRole("button", {
        name: "Merge when checks pass",
      });
      expect(ipc.ghPrAutoMerge).not.toHaveBeenCalled();
      fireEvent.click(offer);
      await waitFor(() =>
        expect(ipc.ghPrAutoMerge).toHaveBeenCalledWith("/policy", 21, "squash", true),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull(),
      );
      expect(screen.queryByText("Merged")).toBeNull();
    });

    it("Dismiss removes the offer without calling GitHub", async () => {
      vi.mocked(ipc.ghPrMerge).mockRejectedValueOnce(new Error(policy));
      await open("/policy-dismiss");
      await screen.findByRole("button", { name: "Merge when checks pass" });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull();
      expect(ipc.ghPrAutoMerge).not.toHaveBeenCalled();
    });

    it("offers nothing for other merge failures", async () => {
      vi.mocked(ipc.ghPrMerge).mockRejectedValueOnce(new Error("merge conflicts"));
      await open("/conflicts");
      // The failed merge is over: the merge button is back, with no offer.
      await screen.findByRole("button", { name: "Squash & merge" });
      expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull();
    });
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
  // Each test waits up to 5 s inside waitFor, so the default 5 s test timeout
  // fired first on a loaded runner (it did on #859's run).
  describe("brain-drafted text", { timeout: 30_000 }, () => {
    const draft = {
      title: "Hub prefetch keeps scrcpy alive",
      message: "Hub prefetch keeps scrcpy alive\n\nWhy it matters.",
      body: "## Summary\nDrafted.",
    };
    const openForm = async () => {
      vi.mocked(ipc.gitStatus).mockResolvedValue({
        is_repo: true,
        branch: "fix/hub-prefetch-scrcpy",
        entries: [{}, {}],
      } as never);
      vi.mocked(ipc.ghPrList).mockResolvedValue([] as never);
      setup({ repo: "/raise", cwd: "/raise" });
      fireEvent.click(
        await screen.findByRole("button", { name: "Commit & raise PR" }),
      );
      return screen.getByLabelText("Pull request title") as HTMLInputElement;
    };
    const submitted = async () => {
      const { runCommitPushPr } = await import("../commitPushPrIpc");
      // The default 1 s wait is too short for a loaded CI runner: the click goes
      // through a dynamic import and a promise race before the IPC is called.
      await waitFor(() => expect(runCommitPushPr).toHaveBeenCalled(), { timeout: 5000 });
      return vi.mocked(runCommitPushPr).mock.calls.at(-1)![0];
    };

    it("fills the title and sends the drafted commit message and body", async () => {
      const { draftPrWithBrain } = await import("../prDraftBrain");
      vi.mocked(draftPrWithBrain).mockResolvedValueOnce(draft);
      const input = await openForm();
      await waitFor(() => expect(input.value).toBe(draft.title), { timeout: 5000 });
      fireEvent.click(screen.getByRole("button", { name: "Raise PR" }));
      expect(await submitted()).toMatchObject({
        title: draft.title,
        message: draft.message,
        body: draft.body,
      });
    });

    it("keeps a title the person typed before the draft arrived", async () => {
      const { draftPrWithBrain } = await import("../prDraftBrain");
      let resolve!: (d: typeof draft) => void;
      vi.mocked(draftPrWithBrain).mockReturnValueOnce(
        new Promise((r) => (resolve = r)),
      );
      const input = await openForm();
      fireEvent.change(input, { target: { value: "My own title" } });
      resolve(draft);
      await Promise.resolve();
      await Promise.resolve();
      expect(input.value).toBe("My own title");
      fireEvent.click(screen.getByRole("button", { name: "Raise PR" }));
      const call = await submitted();
      expect(call).toMatchObject({ title: "My own title", message: "My own title" });
    });

    it("waits for a draft still being written, then uses it", async () => {
      const { draftPrWithBrain } = await import("../prDraftBrain");
      let resolve!: (d: typeof draft) => void;
      vi.mocked(draftPrWithBrain).mockReturnValueOnce(
        new Promise((r) => (resolve = r)),
      );
      await openForm();
      const { runCommitPushPr } = await import("../commitPushPrIpc");
      vi.mocked(runCommitPushPr).mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Raise PR" }));
      expect(await screen.findByText("Working…", {}, { timeout: 5000 })).toBeInTheDocument();
      expect(runCommitPushPr).not.toHaveBeenCalled();
      resolve(draft);
      expect(await submitted()).toMatchObject({
        title: draft.title,
        message: draft.message,
        body: draft.body,
      });
    });

    it("raises with the offline text when the draft takes too long", async () => {
      const { draftPrWithBrain } = await import("../prDraftBrain");
      vi.mocked(draftPrWithBrain).mockReturnValueOnce(new Promise(() => {}));
      await openForm();
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        fireEvent.click(screen.getByRole("button", { name: "Raise PR" }));
        await vi.advanceTimersByTimeAsync(8000);
      } finally {
        vi.useRealTimers();
      }
      const call = await submitted();
      expect(call).toMatchObject({
        title: "Hub prefetch scrcpy",
        message: "Hub prefetch scrcpy",
      });
      expect(call).not.toHaveProperty("body");
    });

    it("stops the draft when the form is cancelled", async () => {
      const { draftPrWithBrain } = await import("../prDraftBrain");
      let signal: AbortSignal | undefined;
      vi.mocked(draftPrWithBrain).mockImplementationOnce(async (opts) => {
        signal = opts.signal;
        return new Promise(() => {});
      });
      await openForm();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(signal?.aborted).toBe(true);
    });
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

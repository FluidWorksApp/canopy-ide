// @vitest-environment jsdom
// The real callbacks from ProjectView/index.tsx, lifted out of the source and run
// against fakes (the same approach as terminalRecovery.integration.test.ts), so the
// wiring around remote launch, pending launches and the squash-merge reap is
// exercised as written rather than re-implemented here.
import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CLIS } from "../../projects";
import { canonicalProjectId } from "../../placement/identity";
import { setPendingLaunch, takePendingLaunch } from "../../placement/pendingLaunch";
import { agentWorkspaceRoot, prLanded, reapDecision } from "../../agentWorkspaceLifecycle";
import { isMergedState } from "../../prMerged";
import type { Target } from "../../placement/types";

const source = readFileSync("src/components/ProjectView/index.tsx", "utf8");

async function lift(code: string, returns: string, context: Record<string, unknown>) {
  const result = await transformWithOxc(`${code}\nreturn ${returns};`, "lifted.ts", { lang: "ts" });
  return new Function(...Object.keys(context), result.code)(...Object.values(context));
}

function callback(name: string, end: string, context: Record<string, unknown>) {
  const start = source.indexOf(`  const ${name} = useCallback(`);
  expect(start, `${name} not found in ProjectView`).toBeGreaterThan(0);
  const stop = source.indexOf(end, start);
  expect(stop, `end marker for ${name}`).toBeGreaterThan(start);
  const useCallback = (fn: unknown) => fn;
  return lift(source.slice(start, stop), name, { useCallback, ...context });
}

const remote: Target = { kind: "remote", workspaceId: "w1" };
const project = { id: "mac-1", name: "Canopy" };

// ---------------------------------------------------------------- prepareMachineLaunch

async function prepare(opts: { outcome: unknown; isRemoteHost?: boolean }) {
  const setMachineTransition = vi.fn();
  const onNotice = vi.fn();
  const resolveProjectMachineLaunch = vi.fn(async () => opts.outcome);
  const fn = await callback("prepareMachineLaunch", "  const rootsRef = useRef(roots);", {
    resolveProjectMachineLaunch,
    setMachineTransition,
    onNotice,
    isRemoteHost: () => opts.isRemoteHost ?? false,
    setPlacementSetupReady: vi.fn(),
    setPlacementSetup: vi.fn(),
    project,
  });
  return { fn, setMachineTransition, onNotice };
}

const transition = { kind: "transition", target: remote, name: "Design Studio" };

describe("starting an agent on another workspace (prepareMachineLaunch)", () => {
  it("starts it there without the switch dialog when the machine accepts the launch", async () => {
    const { fn, setMachineTransition } = await prepare({ outcome: transition });
    const onRemote = vi.fn(async () => ({ kind: "started" as const }));
    expect(await fn("claude", { kind: "target", target: remote }, false, onRemote)).toBe(false);
    expect(onRemote).toHaveBeenCalledWith(remote, "Design Studio");
    expect(setMachineTransition).not.toHaveBeenCalled();
  });

  it("never shows the switch dialog when the machine cannot be used: the reason was already said", async () => {
    const onRemote = async () => ({ kind: "failed" as const });
    const { fn, setMachineTransition } = await prepare({ outcome: transition });
    const then = { kind: "pr-review" as const, payload: { number: 7 } };
    expect(await fn("claude", { kind: "target", target: remote }, { label: "app", then }, onRemote)).toBe(false);
    expect(setMachineTransition).not.toHaveBeenCalled();
  });

  it("a window that is itself on a workspace starts the agent on ANOTHER workspace without switching", async () => {
    const { fn, setMachineTransition } = await prepare({ outcome: transition, isRemoteHost: true });
    const onRemote = vi.fn(async () => ({ kind: "started" as const }));
    await fn("claude", { kind: "target", target: remote }, { label: "app" }, onRemote);
    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(setMachineTransition).not.toHaveBeenCalled();
  });

  it("from a workspace window, a workspace that cannot be used shows no switch dialog either", async () => {
    const { fn, setMachineTransition } = await prepare({ outcome: transition, isRemoteHost: true });
    await fn("claude", { kind: "target", target: remote }, { label: "app" }, vi.fn(async () => ({ kind: "failed" as const })));
    expect(setMachineTransition).not.toHaveBeenCalled();
  });

  it("leaves no resume intent when the caller did not ask for one", async () => {
    const { fn, setMachineTransition } = await prepare({ outcome: transition });
    await fn("claude", { kind: "target", target: remote });
    expect(setMachineTransition).toHaveBeenCalledWith({ target: remote, name: "Design Studio" });
  });

  it("a local target never takes the remote path", async () => {
    const { fn } = await prepare({ outcome: { kind: "transition", target: { kind: "local" }, name: "This Mac" } });
    const onRemote = vi.fn(async () => ({ kind: "started" as const }));
    await fn("claude", { kind: "local" }, false, onRemote);
    expect(onRemote).not.toHaveBeenCalled();
  });

  it("goes ahead and shows the warning when the machine is full", async () => {
    const { fn, onNotice } = await prepare({ outcome: { kind: "launch", decision: { warning: "Design Studio is busy." } } });
    expect(await fn("claude", { kind: "automatic" })).toBe(true);
    expect(onNotice).toHaveBeenCalledWith("Design Studio is busy.", "warn");
  });
});

// ---------------------------------------------------------------- pending launch on arrival

async function arrive(opts: { visible?: boolean; active?: Target } = {}) {
  const start = source.indexOf("  useEffect(() => {\n    if (!visible) return;\n    const intent = takePendingLaunch(");
  expect(start).toBeGreaterThan(0);
  const end = "  }, [visible, project.id]);";
  const code = source.slice(start, source.indexOf(end, start) + end.length);
  let effect: (() => void) | undefined;
  const refs = {
    launchCliRef: { current: vi.fn() },
    addTerminalRef: { current: vi.fn() },
    startPrAgentRef: { current: vi.fn() },
    startTicketWorkRef: { current: vi.fn() },
    componentsRef: { current: [{ label: "site", path: "/w/repo-2" }, { label: "app", path: "/w/repo-1/app" }] },
    repoPathsRef: { current: ["/w/repo-1", "/w/repo-2"] },
  };
  const onNotice = vi.fn();
  const run = await lift(code, "(() => effect())", {
    useEffect: (fn: () => void) => {
      effect = fn;
    },
    effect: () => effect?.(),
    visible: opts.visible ?? true,
    project,
    onNotice,
    takePendingLaunch,
    activeExecutionTarget: () => opts.active ?? remote,
    canonicalProjectId,
    AGENT_CLIS,
    restoreCommand: (id: string, session: string) => `${id} --resume ${session}`,
    TELEPORT_CLI_ID: "claude",
    ...refs,
  });
  return { run, refs, onNotice };
}

beforeEach(() => localStorage.clear());

describe("a launch that waited for the machine switch, on arrival", () => {
  it("a plain start launches the agent in the component that was picked, once", async () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", componentLabel: "app", target: remote });
    const first = await arrive();
    first.run();
    expect(first.refs.launchCliRef.current).toHaveBeenCalledWith(expect.objectContaining({ id: "claude" }), "/w/repo-1/app");
    const second = await arrive();
    second.run();
    expect(second.refs.launchCliRef.current).not.toHaveBeenCalled();
  });

  it("a PR review starts in the repo that holds the component, with that PR", async () => {
    const pr = { number: 12 };
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", componentLabel: "app", target: remote, then: { kind: "pr-review", payload: pr } });
    const { run, refs } = await arrive();
    run();
    expect(refs.startPrAgentRef.current).toHaveBeenCalledWith("review", "/w/repo-1", pr, "claude");
    expect(refs.launchCliRef.current).not.toHaveBeenCalled();
  });

  it("conflict resolution is the same with its own mode", async () => {
    const pr = { number: 13 };
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", target: remote, then: { kind: "pr-resolve", payload: pr } });
    const { run, refs } = await arrive();
    run();
    expect(refs.startPrAgentRef.current).toHaveBeenCalledWith("resolve", "/w/repo-2", pr, "claude");
  });

  it("a ticket starts work on that ticket", async () => {
    const ticket = { id: "T-1" };
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", componentLabel: "site", target: remote, then: { kind: "ticket", payload: ticket } });
    const { run, refs } = await arrive();
    run();
    expect(refs.startTicketWorkRef.current).toHaveBeenCalledWith(ticket, "/w/repo-2", "claude");
  });

  it("a moved session resumes by its id in its folder", async () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", target: remote, then: { kind: "resume", payload: { sessionId: "s1", cwd: "/w/repo-1" } } });
    const { run, refs } = await arrive();
    run();
    expect(refs.addTerminalRef.current).toHaveBeenCalledWith("/w/repo-1", "claude --resume s1", "claude", expect.anything());
  });

  it("is left for the right machine and project, and does nothing while hidden", async () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", target: remote });
    const wrongMachine = await arrive({ active: { kind: "local" } });
    wrongMachine.run();
    expect(wrongMachine.refs.launchCliRef.current).not.toHaveBeenCalled();
    const hidden = await arrive({ visible: false });
    hidden.run();
    expect(hidden.refs.launchCliRef.current).not.toHaveBeenCalled();
    const there = await arrive();
    there.run();
    expect(there.refs.launchCliRef.current).toHaveBeenCalledTimes(1);
  });

  it("ignores an agent that no longer exists", async () => {
    setPendingLaunch({ agentId: "gone", projectId: "mac-1", target: remote });
    const { run, refs, onNotice } = await arrive();
    run();
    expect(refs.launchCliRef.current).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- squash-merge reap

async function reap(over: { pr: string | Error; dirty?: number; head?: string }) {
  const head = over.head ?? "a".repeat(40);
  const worktree = { path: "/w/repo-wt-x", branch: "agent/claude-1", head, is_main: false, locked: null, dirty: over.dirty ?? 0 };
  const work = { branch: "agent/claude-1", dirty: over.dirty ?? 0, ahead: 2, merged: false, upstream: "origin/agent/claude-1", protected: false };
  const ipc = {
    gitWorktrees: vi.fn(async () => [worktree]),
    gitWorkAudit: vi.fn(async () => ({ items: [work] })),
    gitWorktreeRemove: vi.fn(async () => undefined),
    gitBranchDelete: vi.fn(async () => undefined),
    ghPrBranchState: vi.fn(async () => {
      if (over.pr instanceof Error) throw over.pr;
      return over.pr;
    }),
  };
  const ask = vi.fn(async () => "cancel");
  const onNotice = vi.fn();
  const fn = await callback("maybeReapAgentWorkspace", "  const maybeReapAgentWorkspaceRef", {
    agentWorkspaceRoot,
    reapDecision,
    prLanded,
    isMergedState,
    ipc,
    ask,
    onNotice,
    repoPaths: ["/w/repo"],
    tabsRef: { current: [] },
    basename: (p: string) => p.split("/").pop(),
    askDialog: (d: unknown) => d,
    runCommitPushPr: vi.fn(),
  });
  await fn("/w/repo-wt-x/app", "closed-tab");
  return { ipc, ask };
}

describe("closing an agent whose PR was squash-merged", () => {
  it("removes the workspace and branch without asking when the merged head is the local tip", async () => {
    const head = "b".repeat(40);
    const { ipc, ask } = await reap({ pr: `MERGED ${head}`, head });
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.gitWorktreeRemove).toHaveBeenCalledWith("/w/repo", "/w/repo-wt-x", 0);
    expect(ipc.gitBranchDelete).toHaveBeenCalledWith("/w/repo", "agent/claude-1");
  });

  it("still asks when commits were added after the merged head", async () => {
    const { ipc, ask } = await reap({ pr: `MERGED ${"c".repeat(40)}`, head: "d".repeat(40) });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ipc.gitWorktreeRemove).not.toHaveBeenCalled();
  });

  it("still asks when the PR is open, or the state cannot be read", async () => {
    const head = "e".repeat(40);
    for (const pr of [`OPEN ${head}`, new Error("gh missing")]) {
      const { ipc, ask } = await reap({ pr, head });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ipc.gitWorktreeRemove).not.toHaveBeenCalled();
    }
  });

  it("never skips the question when there are uncommitted files", async () => {
    const head = "f".repeat(40);
    const { ipc, ask } = await reap({ pr: `MERGED ${head}`, head, dirty: 2 });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ipc.ghPrBranchState).not.toHaveBeenCalled();
    expect(ipc.gitWorktreeRemove).not.toHaveBeenCalled();
  });
});

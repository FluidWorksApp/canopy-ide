import { describe, expect, it } from "vitest";
import type { TermSubTab } from "./components/ProjectView/helpers";
import {
  groupServers,
  runningCount,
  splitPorts,
  type ServerComponent,
} from "./servers";
import type { AgentRef } from "./workspaces";

const term = (t: Partial<TermSubTab> & { id: string; cwd: string }): TermSubTab => ({
  type: "terminal",
  title: "run",
  ptyId: 1,
  run: true,
  ...t,
});

const web: ServerComponent = {
  id: "cmp-web",
  label: "canopy-website",
  path: "/w/site",
  commands: [
    { id: "run-server", name: "server", command: "npm run dev" },
    { id: "run-build", name: "build", command: "npm run build" },
  ],
};
const app: ServerComponent = {
  id: "cmp-app",
  label: "canopy",
  path: "/w/app",
  commands: [],
};

const noPorts = () => [];

const claudeIn = (ptyId: number) => ({
  sessionId: `s${ptyId}`,
  ptyId,
  name: "claude",
  state: "working" as const,
});

describe("groupServers", () => {
  it("lists only components that have something to run", () => {
    const groups = groupServers([web, app], [], noPorts);
    expect(groups.map((g) => g.label)).toEqual(["canopy-website"]);
    expect(groups[0].entries.map((e) => e.name)).toEqual(["server", "build"]);
    expect(groups[0].entries.every((e) => e.state === "stopped")).toBe(true);
  });

  it("skips commands that are configured but blank", () => {
    const c: ServerComponent = {
      id: "cmp-c",
      label: "c",
      path: "/w/c",
      commands: [{ id: "run-empty", name: "empty", command: "   " }],
    };
    expect(groupServers([c], [], noPorts)).toEqual([]);
  });

  it("reads each command's state off its run tab", () => {
    const tabs = [
      term({ id: "t1", cwd: "/w/site", command: "npm run dev", ptyId: 7 }),
      term({ id: "t2", cwd: "/w/site", command: "npm run build", exited: true, exitCode: 0 }),
    ];
    const [g] = groupServers([web], tabs, (id) => (id === 7 ? [4321] : []));
    expect(g.entries[0]).toMatchObject({ state: "running", ptyId: 7, ports: [4321] });
    expect(g.entries[1]).toMatchObject({ state: "done", exitCode: 0 });
    expect(g.running).toBe(1);
  });

  it("calls a non-zero exit failed and keeps the code", () => {
    const tabs = [
      term({ id: "t1", cwd: "/w/site", command: "npm run build", exited: true, exitCode: 1 }),
    ];
    const [g] = groupServers([web], tabs, noPorts);
    expect(g.entries[1]).toMatchObject({ state: "failed", exitCode: 1 });
  });

  it("counts a tab that has not spawned its pty yet as running", () => {
    const tabs = [term({ id: "t1", cwd: "/w/site", command: "npm run dev", ptyId: null })];
    const [g] = groupServers([web], tabs, noPorts);
    expect(g.entries[0].state).toBe("running");
  });

  it("keeps a run nobody configured, under the component that owns its cwd", () => {
    // What canopy_start_server leaves behind when an agent runs something the
    // project record has never heard of.
    const tabs = [
      term({ id: "t9", cwd: "/w/site/packages/api", command: "bun serve", title: "api" }),
    ];
    const [g] = groupServers([web], tabs, noPorts);
    expect(g.label).toBe("canopy-website");
    expect(g.entries.at(-1)).toMatchObject({ name: "api", adhoc: true, state: "running" });
  });

  it("gives the deepest matching component the run", () => {
    const inner: ServerComponent = {
      id: "cmp-api",
      label: "api",
      path: "/w/site/packages/api",
    };
    const tabs = [term({ id: "t9", cwd: "/w/site/packages/api", command: "bun serve" })];
    const groups = groupServers([web, inner], tabs, noPorts);
    expect(groups.find((g) => g.entries.some((e) => e.adhoc))?.label).toBe("api");
  });

  it("falls back to the directory name when a run belongs to no component", () => {
    const tabs = [term({ id: "t9", cwd: "/elsewhere/tools", command: "make watch" })];
    const groups = groupServers([web], tabs, noPorts);
    expect(groups.map((g) => g.label)).toEqual(["canopy-website", "tools"]);
  });

  it("does not list a finished ad-hoc run", () => {
    const tabs = [
      term({ id: "t9", cwd: "/w/site", command: "one-off", exited: true, exitCode: 0 }),
    ];
    const [g] = groupServers([web], tabs, noPorts);
    expect(g.entries.filter((e) => e.adhoc)).toEqual([]);
  });

  it("never lists one tab twice when two commands share a string", () => {
    const dup: ServerComponent = {
      id: "cmp-duplicate",
      label: "d",
      path: "/w/d",
      commands: [
        { id: "run-a", name: "a", command: "npm run dev" },
        { id: "run-b", name: "a", command: "npm run dev" },
      ],
    };
    const tabs = [term({ id: "t1", cwd: "/w/d", command: "npm run dev" })];
    const [g] = groupServers([dup], tabs, noPorts);
    expect(g.entries.map((e) => e.state)).toEqual(["running", "stopped"]);
    expect(g.entries.map((e) => e.key)).toEqual(["run-a", "run-b"]);
    expect(g.running).toBe(1);
  });

  it("keys configured rows by command ID, independent of names and command text", () => {
    const [before] = groupServers([web], [], noPorts);
    const renamed: ServerComponent = {
      ...web,
      commands: web.commands?.map((command) =>
        command.id === "run-server"
          ? { ...command, name: "frontend", command: "npm run dev:new" }
          : command,
      ),
    };
    const [after] = groupServers([renamed], [], noPorts);

    expect(before.entries.map((entry) => entry.key)).toEqual([
      "run-server",
      "run-build",
    ]);
    expect(after.entries.map((entry) => entry.key)).toEqual([
      "run-server",
      "run-build",
    ]);
  });

  it("uses run identity before cwd and command text, with text matching for legacy tabs", () => {
    const renamed: ServerComponent = {
      ...web,
      commands: web.commands?.map((command) =>
        command.id === "run-server"
          ? { ...command, name: "frontend", command: "npm run dev:new" }
          : command,
      ),
    };
    const identified = term({
      id: "identified",
      cwd: "/w/site",
      command: "npm run dev",
      componentId: "cmp-web",
      runCommandId: "run-server",
    });
    const legacy = term({
      id: "legacy",
      cwd: "/w/site",
      command: "npm run build",
    });

    const [group] = groupServers([renamed], [identified, legacy], noPorts);

    expect(group.entries.map((entry) => entry.tabId)).toEqual([
      "identified",
      "legacy",
    ]);
  });

  it("ignores a run tab from a different component's directory", () => {
    const tabs = [term({ id: "t1", cwd: "/w/other", command: "npm run dev" })];
    const [g] = groupServers([web], tabs, noPorts);
    expect(g.entries[0].state).toBe("stopped");
  });
});

describe("runningCount", () => {
  it("totals the live runs across every group", () => {
    const tabs = [
      term({ id: "t1", cwd: "/w/site", command: "npm run dev" }),
      term({ id: "t2", cwd: "/elsewhere", command: "make watch" }),
    ];
    expect(runningCount(groupServers([web], tabs, noPorts))).toBe(2);
  });
});

describe("workspaces nest under their component", () => {
  const wsWeb: ServerComponent = {
    ...web,
    workspaces: [
      { label: "feat/a", path: "/w/site-wt-a", port: 5174, agents: [claudeIn(7)] },
      { label: "feat/b", path: "/w/site-wt-b", port: 5175, agents: [] },
    ],
  };

  it("does not make a top-level group per component-and-branch pair", () => {
    const groups = groupServers([wsWeb], [], noPorts);
    // Two workspaces must not become two more headings — that is what turned
    // four components into sixteen.
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("canopy-website");
    expect(groups[0].workspaces.map((w) => w.label)).toEqual(["feat/a", "feat/b"]);
  });

  it("gives each workspace the component's commands, in its own directory", () => {
    const [g] = groupServers([wsWeb], [], noPorts);
    const a = g.workspaces[0];
    expect(a.path).toBe("/w/site-wt-a");
    expect(a.entries.map((e) => e.name)).toEqual(["server", "build"]);
    expect(a.agents.map((x) => x.ptyId)).toEqual([7]);
  });

  it("puts a run started on a branch under that branch, not the component", () => {
    const [g] = groupServers(
      [wsWeb],
      [term({ id: "t1", cwd: "/w/site-wt-a", command: "npm run dev" })],
      noPorts,
    );
    expect(g.entries.find((e) => e.name === "server")!.state).toBe("stopped");
    expect(g.workspaces[0].entries.find((e) => e.name === "server")!.state).toBe(
      "running",
    );
    expect(g.workspaces[0].running).toBe(1);
  });

  it("counts a branch's live server in the component header", () => {
    const [g] = groupServers(
      [wsWeb],
      [term({ id: "t1", cwd: "/w/site-wt-a", command: "npm run dev" })],
      noPorts,
    );
    // A collapsed component whose only live server is on a branch must not
    // read as idle.
    expect(g.running).toBe(1);
    expect(runningCount([g])).toBe(1);
  });

  it("claims an unconfigured run in a workspace for that workspace", () => {
    const [g] = groupServers(
      [wsWeb],
      [term({ id: "t9", cwd: "/w/site-wt-b/api", command: "npx tsx watch" })],
      noPorts,
    );
    // Before this it fell through to the ad-hoc pass and became an orphan
    // group named after a directory.
    expect(g.workspaces[1].entries.some((e) => e.adhoc)).toBe(true);
    expect(groupServers([wsWeb], [term({ id: "t9", cwd: "/w/site-wt-b/api" })], noPorts))
      .toHaveLength(1);
  });

  it("leaves a project with no workspaces exactly as it was", () => {
    const [g] = groupServers([web], [], noPorts);
    expect(g.workspaces).toEqual([]);
  });
});

describe("workspaces an agent is in lead the list", () => {
  const ws = (label: string, agents: AgentRef[] = []) => ({
    label,
    path: `/w/site-wt-${label}`,
    port: null,
    agents,
  });

  it("puts the occupied ones above the empty ones", () => {
    const c: ServerComponent = {
      ...web,
      workspaces: [ws("a"), ws("b", [claudeIn(7)]), ws("c"), ws("d", [claudeIn(8)])],
    };
    const [g] = groupServers([c], [], noPorts);
    expect(g.workspaces.map((w) => w.label)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps git's order within each half — the sort is stable", () => {
    const c: ServerComponent = {
      ...web,
      workspaces: [ws("a"), ws("b"), ws("c", [claudeIn(7)])],
    };
    const [g] = groupServers([c], [], noPorts);
    expect(g.workspaces.map((w) => w.label)).toEqual(["c", "a", "b"]);
  });

  it("does not rank by what the agent is doing", () => {
    // Working above idle would reorder the panel on every turn, which is the
    // thing this list must never do.
    const c: ServerComponent = {
      ...web,
      workspaces: [
        ws("a", [{ ...claudeIn(7), state: "idle" as const }]),
        ws("b", [claudeIn(8)]),
      ],
    };
    const [g] = groupServers([c], [], noPorts);
    expect(g.workspaces.map((w) => w.label)).toEqual(["a", "b"]);
  });

  it("does not rank by whether a server is up", () => {
    const c: ServerComponent = { ...web, workspaces: [ws("a"), ws("b")] };
    const [g] = groupServers(
      [c],
      [term({ id: "t1", cwd: "/w/site-wt-b", command: "npm run dev" })],
      noPorts,
    );
    expect(g.workspaces.map((w) => w.label)).toEqual(["a", "b"]);
  });
});

describe("splitPorts", () => {
  it("keeps the port you chose and demotes the ones the OS handed out", () => {
    // The row this was written for: `pnpm tauri dev` listens on Vite's port and
    // two the kernel picked, and all three left no room for "Local Instance".
    const { shown, rest } = splitPorts([5173, 51845, 51729]);
    expect(shown).toEqual([5173]);
    expect(rest).toEqual([51729, 51845]);
  });

  it("shows ephemeral ports when they are the only ones there are", () => {
    // Demoting every port would hide the answer instead of ranking it.
    const { shown, rest } = splitPorts([51729]);
    expect(shown).toEqual([51729]);
    expect(rest).toEqual([]);
  });

  it("makes room for a dev server and its API, and no more", () => {
    const { shown, rest } = splitPorts([3000, 8080, 9229]);
    expect(shown).toEqual([3000, 8080]);
    expect(rest).toEqual([9229]);
  });

  it("dedupes and orders, so the row never reshuffles between polls", () => {
    expect(splitPorts([8080, 3000, 8080]).shown).toEqual([3000, 8080]);
  });

  it("has nothing to say about a run with no ports", () => {
    expect(splitPorts([])).toEqual({ shown: [], rest: [] });
  });
});

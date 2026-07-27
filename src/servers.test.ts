import { describe, expect, it } from "vitest";
import type { TermSubTab } from "./components/ProjectView/helpers";
import { groupServers, runningCount, type ServerComponent } from "./servers";

const term = (t: Partial<TermSubTab> & { id: string; cwd: string }): TermSubTab => ({
  type: "terminal",
  title: "run",
  ptyId: 1,
  run: true,
  ...t,
});

const web: ServerComponent = {
  label: "canopy-website",
  path: "/w/site",
  commands: [
    { name: "server", command: "npm run dev" },
    { name: "build", command: "npm run build" },
  ],
};
const app: ServerComponent = { label: "canopy", path: "/w/app", commands: [] };

const noPorts = () => [];

describe("groupServers", () => {
  it("lists only components that have something to run", () => {
    const groups = groupServers([web, app], [], noPorts);
    expect(groups.map((g) => g.label)).toEqual(["canopy-website"]);
    expect(groups[0].entries.map((e) => e.name)).toEqual(["server", "build"]);
    expect(groups[0].entries.every((e) => e.state === "stopped")).toBe(true);
  });

  it("skips commands that are configured but blank", () => {
    const c: ServerComponent = {
      label: "c",
      path: "/w/c",
      commands: [{ name: "empty", command: "   " }],
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
    const inner: ServerComponent = { label: "api", path: "/w/site/packages/api" };
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
      label: "d",
      path: "/w/d",
      commands: [
        { name: "a", command: "npm run dev" },
        { name: "b", command: "npm run dev" },
      ],
    };
    const tabs = [term({ id: "t1", cwd: "/w/d", command: "npm run dev" })];
    const [g] = groupServers([dup], tabs, noPorts);
    expect(g.entries.map((e) => e.state)).toEqual(["running", "stopped"]);
    expect(g.running).toBe(1);
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

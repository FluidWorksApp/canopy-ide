import { describe, expect, it } from "vitest";
import { clusterWorkItems, workItemSnapshot, type WorkItemJoins } from "./workItems";
import type { SubTab } from "./components/ProjectView/helpers";

const noJoins: WorkItemJoins = { prEdge: () => undefined };

const session = (
  id: string,
  cwd: string,
  ptyId: number,
  extra: Partial<Extract<SubTab, { type: "terminal" }>> = {},
): SubTab => ({
  id,
  type: "terminal",
  cwd,
  title: id,
  ptyId,
  command: "claude",
  ...extra,
});

const shell = (id: string, cwd: string, ptyId: number): SubTab => ({
  id,
  type: "terminal",
  cwd,
  title: id,
  ptyId,
  command: "zsh",
});

const workspace = (
  id: string,
  cwd: string,
  extra: Partial<Extract<SubTab, { type: "agent" }>> = {},
): SubTab => ({
  id,
  type: "agent",
  repo: cwd,
  agent: "claude",
  cwd,
  ...extra,
});

const file = (id: string, path: string): SubTab => ({
  id,
  type: "file",
  file: { path, name: path.split("/").pop() ?? "", kind: "text", view: "source", dirty: false, external: null } as never,
});

const preview = (
  id: string,
  extra: Partial<Extract<SubTab, { type: "preview" }>> = {},
): SubTab => ({ id, type: "preview", url: "http://localhost:3000", annotations: [], ...extra });

const pr = (id: string, repo: string, number: number): SubTab => ({
  id,
  type: "pr",
  repo,
  pr: { number } as never,
});

describe("clusterWorkItems", () => {
  it("clusters a session with its workspace, preview and worktree files", () => {
    const tabs = [
      session("s1", "/w/feat-a", 7),
      workspace("ws1", "/w/feat-a", { ptyId: 7, sessionId: "sess-a" }),
      preview("p1", { initiatorPtyId: 7 }),
      file("f1", "/w/feat-a/src/x.ts"),
      file("f2", "/elsewhere/y.ts"),
    ];
    const groups = clusterWorkItems(tabs, noJoins);
    expect(groups).toContainEqual(["s1", "ws1", "p1", "f1"]);
    expect(groups).toContainEqual(["f2"]);
  });

  it("joins a PR by provenance session id", () => {
    const joins: WorkItemJoins = {
      prEdge: (repo, n) =>
        repo === "/repo" && n === 42 ? { sessionId: "sess-a", cwd: "/w/feat-a" } : undefined,
    };
    const tabs = [
      workspace("ws1", "/w/feat-a", { sessionId: "sess-a" }),
      pr("pr1", "/repo", 42),
      pr("pr2", "/repo", 43),
    ];
    const groups = clusterWorkItems(tabs, joins);
    expect(groups).toContainEqual(["ws1", "pr1"]);
    expect(groups).toContainEqual(["pr2"]);
  });

  it("joins a PR by cwd only when exactly one cluster owns it", () => {
    const joins: WorkItemJoins = {
      prEdge: () => ({ sessionId: "gone", cwd: "/w/shared" }),
    };
    const one = clusterWorkItems([session("s1", "/w/shared", 1), pr("pr1", "/r", 1)], joins);
    expect(one).toContainEqual(["s1", "pr1"]);
    const two = clusterWorkItems(
      [session("s1", "/w/shared", 1), session("s2", "/w/shared", 2), pr("pr1", "/r", 1)],
      joins,
    );
    expect(two).toContainEqual(["pr1"]);
  });

  it("leaves files in a cwd two sessions share loose, deepest cwd wins otherwise", () => {
    const tabs = [
      session("s1", "/repo", 1),
      session("s2", "/repo/.claude/worktrees/feat", 2),
      file("deep", "/repo/.claude/worktrees/feat/src/a.ts"),
      file("shallow", "/repo/src/b.ts"),
    ];
    const groups = clusterWorkItems(tabs, noJoins);
    expect(groups).toContainEqual(["s2", "deep"]);
    expect(groups).toContainEqual(["s1", "shallow"]);

    const shared = clusterWorkItems(
      [session("s1", "/repo", 1), session("s2", "/repo", 2), file("f", "/repo/src/a.ts")],
      noJoins,
    );
    expect(shared).toContainEqual(["f"]);
  });

  it("plain shells and runs found nothing", () => {
    const groups = clusterWorkItems(
      [shell("sh1", "/repo", 1), file("f", "/repo/src/a.ts")],
      noJoins,
    );
    expect(groups).toContainEqual(["sh1"]);
    expect(groups).toContainEqual(["f"]);
  });

  it("a workspace whose session closed founds its own cluster", () => {
    const groups = clusterWorkItems(
      [workspace("ws1", "/w/feat-a", { sessionId: "sess-a" }), file("f", "/w/feat-a/x.ts")],
      noJoins,
    );
    expect(groups).toContainEqual(["ws1", "f"]);
  });

  it("previews join by recipient when there is no initiator", () => {
    const groups = clusterWorkItems(
      [session("s1", "/w", 5), preview("p1", { recipientPtyId: 5 }), preview("p2")],
      noJoins,
    );
    expect(groups).toContainEqual(["s1", "p1"]);
    expect(groups).toContainEqual(["p2"]);
  });

  it("every tab appears exactly once", () => {
    const tabs = [
      session("s1", "/w", 1),
      workspace("ws1", "/w", { ptyId: 1 }),
      file("f1", "/w/a.ts"),
      shell("sh1", "/w", 2),
      preview("p1"),
    ];
    const all = clusterWorkItems(tabs, noJoins).flat().sort();
    expect(all).toEqual(["f1", "p1", "s1", "sh1", "ws1"]);
  });
});

describe("workItemSnapshot", () => {
  it("orders groups by their best-ranked member and members by rank", () => {
    const groups = [
      ["a1", "a2"],
      ["b1", "b2"],
    ];
    const snap = workItemSnapshot(groups, ["a1", "a2", "b1", "b2"], "b2", ["b2", "a2"]);
    expect(snap).toEqual([
      ["b2", "b1"],
      ["a2", "a1"],
    ]);
  });

  it("drops closed tabs and empty groups", () => {
    const snap = workItemSnapshot([["a"], ["b", "c"]], ["c"], null, []);
    expect(snap).toEqual([["c"]]);
  });

  it("unvisited groups keep strip order after the recent ones", () => {
    const snap = workItemSnapshot(
      [["a"], ["b"], ["c"]],
      ["a", "b", "c"],
      "c",
      ["c"],
    );
    expect(snap).toEqual([["c"], ["a"], ["b"]]);
  });

  it("never duplicates a tab listed in two groups", () => {
    const snap = workItemSnapshot([["a", "x"], ["x", "b"]], ["a", "x", "b"], null, []);
    expect(snap.flat().sort()).toEqual(["a", "b", "x"]);
  });
});

// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { rememberTerminals, rememberedTerminalState, forgetTerminals } from "./terminalMemory";
import { rememberedLiveTerminal, recoverLiveGroups } from "./terminalRecovery";
import {
  adoptSnapshotNames,
  multiplexTabName,
  namePatch,
  tabName,
} from "./tabName";
import type { TerminalGroup } from "./terminalGroups";
const group: TerminalGroup = {
  id: "mux",
  ...namePatch({}, "user", "My release team"),
  activeTabId: "b",
  zoomedTabId: "b",
  root: {
    type: "split",
    id: "split",
    axis: "vertical",
    ratio: 0.68,
    first: { type: "leaf", tabId: "a" },
    second: { type: "leaf", tabId: "b" },
  },
};
const rows = [
  {
    tabId: "a",
    ptyId: 1,
    sessionGeneration: 20,
    instance: "backend",
    cwd: "/repo",
    title: "First",
    paneGroup: "mux",
    ...namePatch({}, "user", "First"),
  },
  {
    tabId: "b",
    ptyId: 2,
    sessionGeneration: 21,
    instance: "backend",
    cwd: "/repo",
    title: "Second",
    paneGroup: "mux",
    ...namePatch({}, "user", "Second"),
  },
];
beforeEach(() => localStorage.clear());
it("restores a named mux from durable JSON after visiting a different workspace, even with reversed arrivals", () => {
  rememberTerminals("project", rows, { mux: group }, "remote:A");
  rememberTerminals(
    "project",
    [{ cwd: "/local", title: "Local" }],
    {},
    "local",
  );
  const memory = rememberedTerminalState("project", "remote:A");
  const expected = new Set(["a", "b"]);
  const ids = new Map<string, string>();
  const b = rememberedLiveTerminal(
    memory,
    {
      ptyId: 2,
      sessionGeneration: 21,
      cwd: "/repo",
      name: "Random new native name",
    },
    "backend",
  )!;
  expect(tabName(adoptSnapshotNames(b))).toBe("Second");
  ids.set(b.tabId!, "recovered-b");
  expect(recoverLiveGroups(memory, ids, expected)).toEqual({});
  const a = rememberedLiveTerminal(
    memory,
    { ptyId: 1, sessionGeneration: 20, cwd: "/repo" },
    "backend",
  )!;
  ids.set(a.tabId!, "recovered-a");
  const restored = recoverLiveGroups(memory, ids, expected).mux;
  expect(restored).toEqual({
    ...group,
    activeTabId: "recovered-b",
    zoomedTabId: "recovered-b",
    root: {
      ...group.root,
      first: { type: "leaf", tabId: "recovered-a" },
      second: { type: "leaf", tabId: "recovered-b" },
    },
  });
  expect(
    multiplexTabName(
      restored,
      adoptSnapshotNames(b),
      { agentName: "Changed by agent" },
      2,
    ),
  ).toBe("My release team");
  expect(
    multiplexTabName(
      restored,
      adoptSnapshotNames(a),
      { oscTitle: "New shell title" },
      3,
    ),
  ).toBe("My release team");
  expect(rememberedTerminalState("project", "local").terminals[0].cwd).toBe(
    "/local",
  );
});
it("never gives a recycled PTY a previous session user name or split membership", () => {
  const memory = { terminals: rows, terminalGroups: { mux: group } };
  expect(
    rememberedLiveTerminal(
      memory,
      { ptyId: 1, sessionGeneration: 22, cwd: "/repo" },
      "backend",
    ),
  ).toBeUndefined();
  expect(
    rememberedLiveTerminal(
      memory,
      { ptyId: 1, sessionGeneration: 20, cwd: "/repo" },
      "another-backend",
    ),
  ).toBeUndefined();
});
it("legacy recovery requires a unique exact label and directory instead of guessing between same-command agents", () => {
  const legacy = {
    terminals: rows.map(
      ({ ptyId: _ptyId, sessionGeneration: _generation, instance: _instance, ...row }) => row,
    ),
    terminalGroups: { mux: group },
  };
  expect(
    rememberedLiveTerminal(
      legacy,
      { ptyId: 8, sessionGeneration: 90, cwd: "/repo", name: "First" },
      "new-backend",
    )?.tabId,
  ).toBe("a");
  expect(
    rememberedLiveTerminal(
      legacy,
      { ptyId: 8, sessionGeneration: 90, cwd: "/repo", name: "Random" },
      "new-backend",
    ),
  ).toBeUndefined();
  expect(
    rememberedLiveTerminal(
      { ...legacy, terminals: [legacy.terminals[0], legacy.terminals[0]] },
      { ptyId: 8, sessionGeneration: 90, cwd: "/repo", name: "First" },
      "new-backend",
    ),
  ).toBeUndefined();
});
it("keeps all panes beyond twelve and isolates different remote workspaces", () => {
  const many = Array.from({ length: 18 }, (_, i) => ({
    cwd: "/repo",
    title: `Agent ${i}`,
    tabId: `tab-${i}`,
  }));
  rememberTerminals("project", many, {}, "remote:A");
  rememberTerminals("project", rows, { mux: group }, "remote:B");
  expect(rememberedTerminalState("project", "remote:A").terminals).toEqual(
    many,
  );
  expect(rememberedTerminalState("project", "remote:B").terminalGroups).toEqual(
    { mux: group },
  );
});
it("migrates the original mux user caption independently of which pane arrives first", () => {
  const oldGroup = { ...group, ...namePatch(group, "user", undefined) };
  const restored = recoverLiveGroups(
    { terminals: rows, terminalGroups: { mux: oldGroup } },
    new Map([
      ["b", "new-b"],
      ["a", "new-a"],
    ]),
    new Set(["a", "b"]),
  ).mux;
  expect(
    multiplexTabName(
      restored,
      adoptSnapshotNames(rows[1]),
      { nativeName: "Random" },
      2,
    ),
  ).toBe("First");
});

it("does not inherit new local state or resurrect forgotten legacy remote layouts", () => {
  rememberTerminals("project", rows, { mux: group }, "local");
  expect(rememberedTerminalState("project", "remote:A").terminals).toEqual([]);
  localStorage.setItem(
    "canopy.terminals",
    JSON.stringify({ project: [{ cwd: "/old", title: "Legacy" }] }),
  );
  expect(rememberedTerminalState("project", "remote:A").terminals).toHaveLength(
    1,
  );
  forgetTerminals("project", "remote:A");
  expect(rememberedTerminalState("project", "remote:A").terminals).toEqual([]);
});

// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  rememberTerminals,
  rememberedTerminalState,
  forgetTerminals,
  terminalResumeCards,
} from "./terminalMemory";
import { recoveredIdentity, rememberedLiveTerminal, recoverLiveGroups } from "./terminalRecovery";
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
      ({
        ptyId: _ptyId,
        sessionGeneration: _generation,
        instance: _instance,
        ...row
      }) => row,
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

it("cold resume cards retain legacy mux captions when tree order differs from strip order", () => {
  const old = { ...group, ...namePatch(group, "user", undefined) };
  const reversed = {
    ...old,
    root: {
      type: "split" as const,
      id: "split",
      axis: "vertical" as const,
      ratio: 0.6,
      first: { type: "leaf" as const, tabId: "b" },
      second: { type: "leaf" as const, tabId: "a" },
    },
  };
  const cards = terminalResumeCards(rows, { mux: reversed }, []);
  expect(cards).toHaveLength(1);
  expect(cards[0].group && tabName(cards[0].group)).toBe("First");
});

it("a remote agent resumed after a workspace restart takes its predecessor's tab", () => {
  rememberTerminals("project", rows, { mux: group }, "remote:A");
  const memory = rememberedTerminalState("project", "remote:A");
  const resumed = rememberedLiveTerminal(
    memory,
    { ptyId: 9, sessionGeneration: 9, cwd: "/repo", resumedFrom: 2 },
    "backend",
  );
  expect(resumed).toBeUndefined();
  const remote = rememberedLiveTerminal(
    { ...memory, terminals: memory.terminals.map((t) => t.tabId === "b" ? { ...t, sessionGeneration: 2 } : t) },
    { ptyId: 9, sessionGeneration: 9, cwd: "/repo", resumedFrom: 2 },
    "backend",
  );
  expect(remote?.tabId).toBe("b");
  expect(rememberedLiveTerminal(memory, { ptyId: 9, sessionGeneration: 9, cwd: "/repo" }, "backend")).toBeUndefined();
});

it("a reattached agent tab keeps its own launch command, account and session", () => {
  // Native records a command only for run-rail PTYs, so an agent terminal
  // reattaches with none. Without the snapshot's identity the next snapshot
  // wrote a record titled with the prompt but resumable as nothing.
  const saved = {
    cwd: "/repo",
    command: "claude --dangerously-skip-permissions",
    title: "what were the features…",
    promptName: "what were the features…",
    icon: "✳",
    tabId: "t1",
    ptyId: 2,
    sessionGeneration: 2,
    instance: "backend",
    sessionId: "685a",
    profile: "vj",
  };
  const match = rememberedLiveTerminal(
    { terminals: [saved], terminalGroups: {} },
    { ptyId: 2, sessionGeneration: 2, cwd: "/repo" },
    "backend",
  );
  expect(recoveredIdentity(match, {})).toEqual({
    command: "claude --dangerously-skip-permissions",
    icon: "✳",
    profile: "vj",
    sessionId: "685a",
  });
  // A resume command names its session even when the record predates sessionId.
  expect(
    recoveredIdentity({ ...saved, sessionId: undefined, command: "claude --resume abc" }, {}).sessionId,
  ).toBe("abc");
  // What native says wins; a run's command is never borrowed from memory.
  expect(recoveredIdentity(saved, { command: "npm run dev", run: true }).command).toBe("npm run dev");
  expect(recoveredIdentity(saved, { run: true }).command).toBeUndefined();
  // A legacy name-only match is not proof this PTY ran that command.
  expect(recoveredIdentity({ ...saved, ptyId: undefined }, {})).toEqual({ command: undefined });
  expect(recoveredIdentity(undefined, {})).toEqual({ command: undefined });
});

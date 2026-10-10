// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";
import { expect, it, vi } from "vitest";
import {
  adoptSnapshotNames,
  isUserNamed,
  namePatch,
  tabName,
} from "../../tabName";
import { rememberedLiveTerminal } from "../../terminalRecovery";
import {
  leafIds,
  mapSplitTabIds,
  type TerminalGroup,
} from "../../terminalGroups";
import { restoredFront } from "./helpers";

const source = readFileSync("src/components/ProjectView/index.tsx", "utf8");
async function callback(
  name: string,
  end: string,
  context: Record<string, unknown>,
) {
  const start = source.indexOf(`  const ${name} = useCallback(`);
  expect(start).toBeGreaterThan(0);
  const code = source.slice(start, source.indexOf(end, start));
  const result = await transformWithOxc(
    `${code}\nreturn ${name};`,
    "callback.ts",
    { lang: "ts" },
  );
  return new Function(...Object.keys(context), result.code)(
    ...Object.values(context),
  );
}

it("the actual live attachment callback reuses saved identities and names instead of generating new tabs", async () => {
  let tabs: any[] = [];
  const tabsRef = {
    get current() {
      return tabs;
    },
  };
  const memory = {
    terminals: [
      {
        tabId: "chosen-tab",
        ptyId: 17,
        sessionGeneration: 9,
        instance: "instance",
        cwd: "/repo",
        title: "My choice",
        ...namePatch({}, "user", "My choice"),
      },
    ],
    terminalGroups: {},
  };
  const ids = { current: new Map() };
  const createId = vi.fn(() => "random-tab");
  const attach = await callback(
    "attachTerminal",
    "\n  // App routes native PTYs",
    {
      useCallback: (fn: any) => fn,
      tabsRef,
      thisInstanceRef: { current: "instance" },
      terminalRecoveryMemory: memory,
      rememberedLiveTerminal,
      recoveredTabIds: ids,
      tabId: createId,
      componentsRef: { current: [] },
      setTabs: (update: any) => {
        tabs = update(tabs);
      },
      setActiveTabId: vi.fn(),
      adoptSnapshotNames,
      unattendedManagedRunCommand: vi.fn(),
    },
  );
  const id = attach(
    17,
    "/repo",
    "Random title",
    "",
    false,
    false,
    "New native label",
    { recovered: false, sessionGeneration: 9, run: false },
  );
  expect(id).toBe("chosen-tab");
  expect(tabName(tabs[0])).toBe("My choice");
  expect(ids.current.get("chosen-tab")).toBe("chosen-tab");
  expect(createId).not.toHaveBeenCalled();
  attach(
    17,
    "/repo",
    "Another random title",
    "",
    false,
    false,
    "Changed again",
    { recovered: true, sessionGeneration: 9, run: false },
  );
  expect(tabs).toHaveLength(1);
  expect(tabName(tabs[0])).toBe("My choice");
});

it("the actual conversation resume callback restores user labels and mux layout together", async () => {
  let tabs: any[] = [
    { id: "resumed-a", type: "terminal" },
    { id: "resumed-b", type: "terminal" },
  ];
  const groups = { current: {} };
  const front = vi.fn();
  const resume = await callback(
    "restoreResumeCard",
    "\n  /** Carry out an accepted reload",
    {
      useCallback: (fn: any) => fn,
      resumeSession: vi.fn(async (r: any) => `resumed-${r.key}`),
      reopenTerminal: vi.fn(),
      restoreTerminalNames: await callback(
        "restoreTerminalNames",
        "\n  /** Record a user rename",
        {
          useCallback: (fn: any) => fn,
          setTabs: (update: any) => {
            tabs = update(tabs);
          },
          adoptSnapshotNames,
          isUserNamed,
        },
      ),
      adoptSnapshotNames,
      mapSplitTabIds,
      leafIds,
      setTabs: (update: any) => {
        tabs = update(tabs);
      },
      terminalGroupsRef: groups,
      setTerminalGroups: vi.fn(),
      setActiveTabId: front,
      restoredFront,
    },
  );
  const group: TerminalGroup = {
    id: "mux",
    root: {
      type: "split",
      id: "split",
      axis: "horizontal",
      ratio: 0.7,
      first: { type: "leaf", tabId: "old-a" },
      second: { type: "leaf", tabId: "old-b" },
    },
    activeTabId: "old-b",
    ...namePatch({}, "user", "My team"),
  };
  await resume({
    group,
    leaves: [
      {
        restorable: { key: "a" },
        remembered: {
          tabId: "old-a",
          title: "Stable A",
          ...namePatch({}, "user", "Stable A"),
        },
      },
      {
        restorable: { key: "b" },
        remembered: {
          tabId: "old-b",
          title: "Stable B",
          ...namePatch({}, "user", "Stable B"),
        },
      },
    ],
  });
  expect(tabs.map((t) => tabName(t))).toEqual(["Stable A", "Stable B"]);
  expect(tabs.map((t) => t.paneGroup)).toEqual(["mux", "mux"]);
  expect(groups.current).toEqual({
    mux: {
      ...group,
      root: {
        ...group.root,
        first: { type: "leaf", tabId: "resumed-a" },
        second: { type: "leaf", tabId: "resumed-b" },
      },
      activeTabId: "resumed-b",
    },
  });
  expect(front).toHaveBeenCalledWith("resumed-b");
});

it("renaming the mux writes its own durable label without renaming a member session", async () => {
  const group: TerminalGroup = {
    id: "mux",
    activeTabId: "a",
    root: {
      type: "split",
      id: "s",
      axis: "vertical",
      ratio: 0.5,
      first: { type: "leaf", tabId: "a" },
      second: { type: "leaf", tabId: "b" },
    },
  };
  const groups = { current: { mux: group } };
  const rename = vi.fn();
  const panePatch = vi.fn();
  const setGroups = vi.fn();
  const commit = await callback("commitRename", "\n  const cancelRename", {
    useCallback: (fn: any) => fn,
    renamingTabId: "a",
    renameDraft: "My permanent team",
    tabsRef: {
      current: [{ id: "a", type: "terminal", ptyId: 1, paneGroup: "mux" }],
    },
    renamingGroupId: { current: "mux" },
    terminalGroupsRef: groups,
    namePatch,
    setTerminalGroups: setGroups,
    renameSession: rename,
    patchTab: panePatch,
    onNotice: vi.fn(),
    setRenamingTabId: vi.fn(),
  });
  commit();
  expect(tabName(groups.current.mux)).toBe("My permanent team");
  expect(setGroups).toHaveBeenCalledWith(groups.current);
  expect(rename).not.toHaveBeenCalled();
  expect(panePatch).not.toHaveBeenCalled();
});

it("restoring an old snapshot cannot replace the user name of an already open tab", async () => {
  let tabs = [
    {
      id: "live",
      type: "terminal",
      ...namePatch({}, "user", "My newer choice"),
    },
  ];
  const restore = await callback(
    "restoreTerminalNames",
    "\n  /** Record a user rename",
    {
      useCallback: (fn: any) => fn,
      setTabs: (update: any) => {
        tabs = update(tabs);
      },
      isUserNamed,
      adoptSnapshotNames,
    },
  );
  restore("live", { title: "Old name", ...namePatch({}, "user", "Old name") });
  expect(tabName(tabs[0])).toBe("My newer choice");
});

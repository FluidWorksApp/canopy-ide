// @vitest-environment jsdom
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaneBar } from "./PaneBar";
import type { StripGroup, SubTab, TermSubTab } from "./ProjectView/helpers";

// The bar's own module graph, not ProjectView's: PaneBar only needs two label
// helpers from there, and importing the real index would drag the whole view
// (and its IPC) into a test about an input's selection range.
vi.mock("./ProjectView", () => ({
  tabDisplayLabel: (t: SubTab) => t.id,
  previewLabel: (url: string) => url,
}));

// jsdom has neither, and the harbor blob measures with both.
if (!("fonts" in document))
  Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() } });
if (!globalThis.ResizeObserver)
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

const term = (id: string, title: string): TermSubTab => ({
  id,
  type: "terminal",
  cwd: "/repo",
  title,
  ptyId: 1,
});

const noop = () => {};
const drag = { dragId: null, dragOffsetX: 0, itemProps: (id: string) => ({ "data-drag-id": id, onPointerDown: noop }) };

/** One open, unlabelled run — the flat strip, which is what these tests are
 *  about. Stack folding has its own tests in tabGroups.test.ts. */
const run = (key: string, tabs: SubTab[]): StripGroup => ({
  key,
  label: null,
  status: null,
  icon: null,
  tabs,
  shown: tabs,
});

function paneBar(over: Partial<React.ComponentProps<typeof PaneBar>> = {}) {
  const tabs = (over.tabGroups?.flatMap((g) => g.shown) ?? []) as SubTab[];
  return (
    <PaneBar
      tabGroups={[]}
      stripTabs={tabs}
      activeTabId={null}
      flashTabId={null}
      renamingTabId={null}
      renameDraft=""
      collabPaths={new Set()}
      isAgentTab={(t): t is TermSubTab => t.type === "terminal"}
      tabState={() => "idle"}
      stripDrag={drag}
      stripRef={createRef<HTMLDivElement>()}
      openStacks={{}}
      onToggleStack={noop}
      showHints={false}
      shellChips={[]}
      runChips={[]}
      runSummary={null}
      shellMenuOpen={false}
      setShellMenuOpen={noop}
      runMenuOpen={false}
      setRunMenuOpen={noop}
      activeSection="tabs"
      isSharedFile={false}
      isRelayConnectedWithPeers={false}
      isTerminalTab={false}
      cliMenuOpen={false}
      setCliMenuOpen={noop}
      installed={{}}
      cliUpdates={{}}
      shareMenuOpen={false}
      setShareMenuOpen={noop}
      shareProjectMenuOpen={false}
      setShareProjectMenuOpen={noop}
      relayMembers={[]}
      isProjectShared={() => false}
      onSelectTab={noop}
      onTabContextMenu={noop}
      onCloseTab={noop}
      onCommitRename={noop}
      onCancelRename={noop}
      onRenameDraftChange={noop}
      onNewShell={noop}
      onClearScrollback={noop}
      onHardReset={noop}
      onToggleView={noop}
      onShareFile={noop}
      onShareProject={noop}
      onOpenPreview={noop}
      onLaunchCli={noop}
      onRunCliUpdate={noop}
      onRefreshInstalled={noop}
      onRefreshUpdates={noop}
      onOpenAllTabs={noop}
      activeTabElRef={createRef<HTMLDivElement>()}
      {...over}
    />
  );
}

const renameInput = () => document.querySelector<HTMLInputElement>(".tab-rename-input")!;

describe("PaneBar tab rename", () => {
  it("focuses the input and selects the whole name when a rename starts", () => {
    const groups = [run("all", [term("t1", "zsh")])];
    const { rerender } = render(paneBar({ tabGroups: groups }));
    expect(document.querySelector(".tab-rename-input")).toBeNull();

    rerender(paneBar({ tabGroups: groups, renamingTabId: "t1", renameDraft: "zsh" }));

    const el = renameInput();
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe("zsh".length);
  });

  it("does not re-select while the draft is being typed", () => {
    const groups = [run("all", [term("t1", "zsh")])];
    const { rerender } = render(
      paneBar({ tabGroups: groups, renamingTabId: "t1", renameDraft: "zsh" }),
    );
    // What typing over the selection looks like: the draft is replaced and the
    // caret sits at the end. A re-running effect would highlight it all again.
    renameInput().setSelectionRange(1, 1);
    rerender(paneBar({ tabGroups: groups, renamingTabId: "t1", renameDraft: "b" }));

    const el = renameInput();
    expect(el.selectionStart).toBe(1);
    expect(el.selectionEnd).toBe(1);
  });

  it("selects the name of the next tab when the rename moves to it", () => {
    const groups = [run("all", [term("t1", "zsh"), term("t2", "server")])];
    const { rerender } = render(
      paneBar({ tabGroups: groups, renamingTabId: "t1", renameDraft: "zsh" }),
    );
    rerender(paneBar({ tabGroups: groups, renamingTabId: "t2", renameDraft: "server" }));

    const el = renameInput();
    expect(el.value).toBe("server");
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe("server".length);
  });

  it("shows the tab name as static text when nothing is being renamed", () => {
    render(paneBar({ tabGroups: [run("all", [term("t1", "zsh")])] }));
    expect(screen.getByText("zsh")).toHaveClass("tab-title");
  });
});

// The strip's runs live here but their state lives in ProjectView; these are
// about the wiring between the two, which is what the ProjectView/ split moved.
const stack = (over: Partial<StripGroup>): StripGroup => ({
  key: "quiet",
  label: "Idle",
  status: "quiet",
  icon: null,
  tabs: [],
  shown: [],
  ...over,
});

describe("PaneBar stacks", () => {
  it("renders no chip at all for a run with nothing in it", () => {
    render(paneBar({ tabGroups: [stack({})] }));
    expect(document.querySelector(".tab-stack")).toBeNull();
    expect(document.querySelector(".tab-group")).toBeNull();
  });

  it("names a run on its chip and counts everything in it, folded or not", () => {
    const tabs = [term("t1", "zsh"), term("t2", "server")];
    render(paneBar({ tabGroups: [stack({ tabs, shown: [tabs[0]] })] }));

    expect(screen.getByText("Idle")).toHaveClass("tab-stack-name");
    // Two in the stack, one on screen: the count is the stack's, not the row's.
    expect(screen.getByText("2")).toHaveClass("tab-stack-count");
    expect(document.querySelectorAll(".tab")).toHaveLength(1);
  });

  it("says one number with one caret, however much is out of sight", () => {
    // The chip used to carry a fold chevron AND an overflow caret, each with a
    // count of its own: "Idle 2 › 1 ⌄" left you working out which number meant
    // what. Anything folded away or scrolled out of view is reachable from the
    // bar's own all-tabs menu, which lists every tab in the strip.
    const tabs = [term("t1", "zsh"), term("t2", "server"), term("t3", "log")];
    render(
      paneBar({
        tabGroups: [stack({ tabs, shown: tabs.slice(0, 2) })],
      }),
    );
    const chip = document.querySelector(".tab-stack")!;
    expect(chip.querySelectorAll("button")).toHaveLength(1);
    expect(chip.querySelectorAll("svg")).toHaveLength(1);
    expect(chip.querySelectorAll(".tab-stack-count")).toHaveLength(1);
    // And the one number is the stack's size, not what happens to be on screen.
    expect(chip.querySelector(".tab-stack-count")!.textContent).toBe("3");
    // And it looks the same whether or not the strip has scrolled it against
    // the edge: expanding a stack scrolls the strip, so a chip that restyled
    // itself when pinned meant opening one stack made its neighbour flinch.
    expect(chip.className.trim()).toBe("tab-stack");
  });

  it("marks a folded run, and never counts the active tab it is holding out", () => {
    const tabs = [term("t1", "zsh"), term("t2", "server")];
    render(
      paneBar({
        tabGroups: [stack({ tabs, shown: [tabs[1]] })],
        openStacks: { quiet: false },
        activeTabId: "t2",
      }),
    );
    expect(document.querySelector(".tab-group")).toHaveClass("tab-group-folded");
    // Folded, so the chip says how to get the rest back rather than how to fold.
    expect(
      document.querySelector<HTMLButtonElement>(".tab-stack-face")!.title,
    ).toBe("1 idle folded — click to open");
    // …and the tab it is holding out is still in the strip, and still active.
    expect(document.querySelector(".tab")).toHaveClass("tab-active");
  });

  it("gives the whole strip one drag handle, not one per run", () => {
    const itemProps = vi.fn((id: string) => ({
      "data-drag-id": id,
      onPointerDown: noop,
    }));
    render(
      paneBar({
        tabGroups: [
          run("attention", [term("t1", "zsh")]),
          run("files", [term("t2", "server")]),
        ],
        stripDrag: { dragId: null, dragOffsetX: 0, itemProps },
      }),
    );
    expect(itemProps.mock.calls.map(([id]) => id)).toEqual(["t1", "t2"]);
  });
});

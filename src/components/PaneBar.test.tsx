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
      stripOverflow={{}}
      onStackOverflow={noop}
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

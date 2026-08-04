import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { LifeState } from "../../shared/agentLife";
import {
  AgentIcon,
  AgentsIcon,
  ChevronIcon,
  ClaimIcon,
  CloseIcon,
  CommitIcon,
  GitBranchIcon,
  GlobeIcon,
  LiveShareIcon,
  PlugIcon,
  PullRequestIcon,
  TeamIcon,
  TerminalIcon,
  TrackerIcon,
} from "./icons";
import type { AgentCli } from "../projects";
import { AGENT_CLIS } from "../projects";
import type { TabDrag } from "../tabDrag";
import {
  ANCHOR_ATTR,
  contentLeft,
  GROUP_ATTR,
  useStickyLayout,
} from "../tabSticky";
import type {
  SubTab,
  TermSubTab,
  RailChip,
  StripGroup,
} from "./ProjectView";
import { tabDisplayLabel, previewLabel, deviceLabel } from "./ProjectView";
import { claimOwnerName } from "../claims";
import { Button } from "./ui";

export type { SubTab, RailChip };

function tabTitle(tab: SubTab): string {
  switch (tab.type) {
    case "terminal": return `${tab.multiplexCount ? `${tab.multiplexCount} independent panes\n` : ""}${tab.notice ? `${tab.notice}\n` : ""}${tab.command ?? ""} — ${tab.cwd}${tab.profile ? `\naccount: ${tab.profile}` : ""}`;
    case "pr": return `${tab.pr.title} — ${tab.pr.url}`;
    case "ticket": return `${tab.ticket.id} — ${tab.ticket.title}\n${tab.ticket.url}`;
    case "research": return `Research ${tab.researchId} — ${tab.title}`;
    case "note": return `Note ${tab.noteId} — ${tab.title}`;
    case "commit": return `${tab.short} — ${tab.subject}`;
    case "branch": return `${tab.branch.branch}\n${tab.branch.worktree ?? "no worktree"}`;
    case "agent": return `${tab.agent} workspace\n${tab.cwd}`;
    case "chat": return tab.peer === null ? "Team chat — everyone on the relay" : `Direct chat with ${tab.name}`;
    case "collab": return `${tab.name} — live, owned by ${tab.ownerName}`;
    case "review": return `Review from ${tab.review.from}: ${tab.review.title}`;
    case "agents": return "Every agent session in this project — running, past, and how each CLI is wired in";
    case "research-list": return "Every research entry in this project";
    case "notes-list": return "Every note in this project's scratchpad";
    case "prs-list": return "Every open pull request in this project";
    case "issues-list": return "Every issue from this project's connected trackers";
    case "task-history": return "Every one-shot task that has finished, and what it reported";
    case "instructions": return "CLAUDE.md, AGENTS.md, skills and subagents — what every agent reads first";
    case "mcp": return `${tab.server.name} — the tools this MCP server exposes, and who can reach it`;
    case "claim": return `${claimOwnerName(tab.claim.owner)} claimed ${tab.claim.paths.join(", ")}${tab.claim.note ? `\n${tab.claim.note}` : ""}`;
    case "shared-project": return `${tab.name} — shared live by ${tab.ownerName}`;
    case "preview": return tab.url || "Preview";
    case "device": return tab.serial ? `Android device ${tab.serial}` : "Android device";
    case "file": return tab.file.path;
  }
}

function tabText(tab: SubTab): string {
  switch (tab.type) {
    case "terminal": return tab.multiplexTitle ?? tab.customTitle ?? tab.title;
    case "pr": return `#${tab.pr.number} ${tab.pr.title}`;
    case "ticket": return `${tab.ticket.id} ${tab.ticket.title}`;
    case "research": return tabDisplayLabel(tab);
    case "note": return tabDisplayLabel(tab);
    case "commit": return `${tab.short} ${tab.subject}`;
    case "branch": return tab.branch.branch;
    case "agent": return tabDisplayLabel(tab);
    case "chat": return tab.name;
    case "collab": return `${tab.name} ⇄`;
    case "review": return tab.review.title;
    case "agents": return "Agents";
    case "research-list": return "All research";
    case "notes-list": return "Scratchpad";
    case "prs-list": return "Pull requests";
    case "issues-list": return "Issues";
    case "task-history": return "Completed tasks";
    case "instructions": return "Agent instructions";
    case "mcp": return tab.server.name;
    case "claim": return tabDisplayLabel(tab);
    case "shared-project": return tab.name;
    case "preview": return previewLabel(tab.url);
    case "device": return deviceLabel(tab.serial);
    case "file": return `${tab.file.name}${tab.file.dirty ? " •" : ""}`;
  }
}

// ── Rail (shells / runs dropdown) ────────────────────────────────────────────

function Rail({
  label, chips, summary, open, setOpen, dim,
}: {
  label: string; chips: RailChip[]; summary: React.ReactNode;
  open: boolean; setOpen: (v: boolean) => void; dim?: boolean;
}) {
  if (chips.length === 0) return null;
  const dimCls = dim ? "pane-section-dim" : "";
  const chip = (c: RailChip, inMenu: boolean) => (
    <div
      key={c.id}
      className={`run-chip ${c.className ?? ""} ${c.active ? "run-chip-active" : ""} ${inMenu ? "rail-menu-chip" : ""}`}
      onClick={() => { c.onSelect(); if (inMenu) setOpen(false); }}
      title={c.tooltip}
    >
      {c.dot}
      <span className="run-chip-title">{c.title}</span>
      {c.action}
      <span className="tab-close" title="Close" onClick={(e) => { e.stopPropagation(); c.onClose(); }}><CloseIcon size={12} /></span>
    </div>
  );
  if (chips.length === 1) {
    return (
      <div className={`run-rail ${dimCls}`} data-rail={label}>
        <span className="run-rail-label">{label}</span>
        {chip(chips[0], false)}
      </div>
    );
  }
  const active = chips.find((c) => c.active);
  return (
    <div className={`run-rail rail-menu-anchor ${dimCls}`} data-rail={label}>
      <span className="run-rail-label">{label}</span>
      <button
        className={`run-chip rail-toggle ${active ? "run-chip-active" : ""}`}
        onClick={() => setOpen(!open)}
        title={`${chips.length} ${label.toLowerCase()}`}
      >
        {summary}
        <span className="run-chip-title">{active ? active.title : label}</span>
        <span className="rail-count">{chips.length}</span>
        <span className="rail-caret">▾</span>
      </button>
      {open && (
        <div className="cli-menu rail-menu" onMouseLeave={() => setOpen(false)}>
          {chips.map((c) => chip(c, true))}
        </div>
      )}
    </div>
  );
}

// ── PaneBar props ─────────────────────────────────────────────────────────────

export interface PaneBarProps {
  // tab data
  /** One run of the strip per entry: three agent stacks (or one flat agent run
   *  when grouping is off), then one per kind of document. */
  tabGroups: StripGroup[];
  stripTabs: SubTab[];
  activeTabId: string | null;
  flashTabId: string | null;
  renamingTabId: string | null;
  renameDraft: string;
  collabPaths: Set<string>;
  isAgentTab: (t: SubTab) => t is TermSubTab;
  tabState: (t: TermSubTab) => LifeState;
  /** Unseen activity on this terminal — an additive ring, never a state of its
   *  own and never a reason to move the tab. */
  tabRing?: (t: TermSubTab) => boolean;
  /** Drag-to-reorder for the whole strip. One handle, not one per run: a tab is
   *  still confined to the run it was picked up from (the runs are handed to
   *  useTabDragGroups), but a dozen runs must not cost a dozen sets of window
   *  listeners. */
  stripDrag: TabDrag;
  /** The scroll container itself, measured by the owner: which chips are pinned
   *  and where the active tab has to be scrolled to are both questions about
   *  this element, and both are answered where the strip's state lives. */
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** Folded stacks, by run key. Absent means open — only a fold the user
   *  actually asked for is stored. */
  openStacks: Record<string, boolean>;
  onToggleStack: (key: string) => void;
  /** Offer everything a run is hiding — folded or scrolled behind the pin. */
  /** Whether the first nine tabs show their direct-jump digits. */
  showHints: boolean;
  // rail data
  shellChips: RailChip[];
  runChips: RailChip[];
  runSummary: React.ReactNode;
  shellMenuOpen: boolean;
  setShellMenuOpen: (v: boolean) => void;
  runMenuOpen: boolean;
  setRunMenuOpen: (v: boolean) => void;
  activeSection: "tabs" | "shells" | "runs";
  // active tab extra
  activeFileKind?: string;
  activeFileView?: string;
  isSharedFile: boolean;
  isRelayConnectedWithPeers: boolean;
  // launcher
  cliMenuOpen: boolean;
  setCliMenuOpen: (v: boolean) => void;
  installed: Record<string, boolean>;
  cliUpdates: Record<string, { hasUpdate?: boolean; installed?: string; latest?: string }>;
  // share menus
  shareMenuOpen: boolean;
  setShareMenuOpen: (v: boolean) => void;
  shareProjectMenuOpen: boolean;
  setShareProjectMenuOpen: (v: boolean) => void;
  relayMembers: { id: string; name: string }[];
  isProjectShared: (memberId: string) => boolean;
  /** True only when the active tab is a terminal — gates scrollback/reset buttons. */
  isTerminalTab: boolean;
  // callbacks
  onSelectTab: (id: string, clickCount?: number) => void;
  onTabContextMenu: (e: React.MouseEvent, tab: SubTab) => void;
  onCloseTab: (id: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRenameDraftChange: (v: string) => void;
  onNewShell: () => void;
  onClearScrollback: () => void;
  onHardReset: () => void;
  onToggleView: () => void;
  onShareFile: (memberId: string, memberName: string) => void;
  onShareProject: (memberId: string, memberName: string) => void;
  onOpenPreview: () => void;
  onLaunchCli: (cli: AgentCli) => void;
  /** The non-default account new agents launch as, and the profile-capable
   *  CLIs it holds no login for yet. Null on the default account. */
  account?: { label: string; missing: string[] } | null;
  /** Profile id -> display name, so a badge shows the name the user typed. */
  profileLabels?: Record<string, string>;
  onRunCliUpdate: (cli: AgentCli, e: React.MouseEvent) => void;
  onRefreshInstalled: () => void;
  onRefreshUpdates: () => void;
  onOpenAllTabs: (e: React.MouseEvent) => void;
  activeTabElRef: React.RefObject<HTMLDivElement | null>;
}

// ── PaneBar ───────────────────────────────────────────────────────────────────

function PaneBarImpl({
  tabGroups, stripDrag, stripRef, openStacks, onToggleStack,
  stripTabs, activeTabId, flashTabId, renamingTabId, renameDraft,
  collabPaths, isAgentTab, tabState, tabRing, showHints,
  shellChips, runChips, runSummary, shellMenuOpen, setShellMenuOpen,
  runMenuOpen, setRunMenuOpen, activeSection,
  activeFileKind, activeFileView,
  isSharedFile, isRelayConnectedWithPeers, isTerminalTab,
  cliMenuOpen, setCliMenuOpen, installed, cliUpdates,
  shareMenuOpen, setShareMenuOpen, shareProjectMenuOpen, setShareProjectMenuOpen,
  relayMembers, isProjectShared,
  onSelectTab, onTabContextMenu, onCloseTab, onCommitRename, onCancelRename,
  onRenameDraftChange, onNewShell,
  onClearScrollback, onHardReset, onToggleView,
  onShareFile, onShareProject, onOpenPreview, onLaunchCli, account, profileLabels, onRunCliUpdate,
  onRefreshInstalled, onRefreshUpdates, onOpenAllTabs,
  activeTabElRef,
}: PaneBarProps) {
  // Harbor tabs: the docked active-tab shape is a single element that glides
  // between tabs, staying fused with the editor surface below, instead of the
  // .tab-active styling teleporting. We measure the active tab (via the ref the
  // container already threads to it) and animate a blob to its box.
  const tabsRowRef = useRef<HTMLDivElement | null>(null);
  const blobElRef = useRef<HTMLSpanElement>(null);
  const [blob, setBlob] = useState<{ left: number; width: number } | null>(null);

  const measureBlob = () => {
    const el = (activeTabElRef as React.RefObject<HTMLDivElement>)?.current;
    const row = tabsRowRef.current;
    if (!el || !row) { setBlob((b) => (b === null ? b : null)); return; }
    const next = { left: contentLeft(row, el), width: el.offsetWidth };
    setBlob((prev) => {
      if (prev && prev.left === next.left && prev.width === next.width) return prev;
      // Arm the compositing-layer hint only when geometry actually changes.
      // Disarm on transitionend (normal path) or after a timeout (no transition
      // fires: reduced-motion, instant re-measure, or blob was null).
      const blobEl = blobElRef.current;
      if (blobEl) {
        blobEl.classList.add("blob-animating");
        const off = () => blobEl.classList.remove("blob-animating");
        blobEl.addEventListener("transitionend", off, { once: true });
        window.setTimeout(off, 400); // fallback: longer than --dur-med
      }
      return next;
    });
  };

  // Re-measure when the tab set or active tab changes.
  useLayoutEffect(measureBlob, [activeTabId, tabGroups, stripTabs, renamingTabId, activeTabElRef]);

  // Re-measure on geometry changes that leave the tab set unchanged: panel
  // resize, window resize, zoom changes, and font loading (font swap changes
  // tab widths without resizing the row).
  useEffect(() => {
    const row = tabsRowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(measureBlob);
    ro.observe(row);
    void document.fonts.ready.then(measureBlob);
    return () => ro.disconnect();
    // measureBlob reads refs; no dep needed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A rename replaces the name far more often than it edits it, so start with
  // the whole thing selected — autoFocus alone parks the caret at the end and
  // leaves you to clear the name by hand. An effect rather than a ref that
  // focuses during the commit: FileTree's rename prompt needed one to stop the
  // closing context menu winning the focus race, and this input mounts from a
  // context menu too. Keyed on the tab, so typing never re-selects the draft.
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Which tabs are genuinely new, so only those play the appear animation.
  //
  // The animation exists so a tab you just opened does not pop in at full
  // strength. Folding a stack unmounts the tabs inside it (a folded run shows
  // nothing), so unfolding remounted them and every one replayed the animation
  // — opacity from 0.3 up, which on the active tab reads as its highlight
  // arriving half-lit and then snapping to full. Scrolling a strip whose runs
  // fold and unfold as you go did it repeatedly.
  //
  // `stripTabs` is every tab in the strip whether or not its run is folded, so
  // a tab returning from a fold was already known and does not animate.
  const seenTabs = useRef<Set<string>>(new Set());
  const isNewTab = (id: string) => !seenTabs.current.has(id);
  useEffect(() => {
    seenTabs.current = new Set(stripTabs.map((t) => t.id));
  }, [stripTabs]);


  useEffect(() => {
    if (renamingTabId == null) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renamingTabId]);

  // Numbered left to right across every group, so a hint matches what the eye
  // counts: the agent/doc split is a visual grouping, not a numbering reset.
  // Only what is actually on screen — a digit pointing at a tab folded into a
  // stack would be a hint for something you can't see. Only the first nine —
  // ⌘0 is zoom reset, and nobody counts past a row.
  const hints = new Map<string, number>();
  if (showHints)
    tabGroups
      .flatMap((g) => g.shown)
      .slice(0, 9)
      .forEach((t, i) => hints.set(t.id, i + 1));

  // Sticky sections are counted only over runs actually drawn. Empty runs have
  // no header or containing block, so the next section meets the previous one
  // directly.
  useStickyLayout(stripRef);
  const drawn = tabGroups.filter((g) => g.tabs.length > 0);
  const pinIndex = new Map<string, number>();
  for (const g of drawn) if (g.label) pinIndex.set(g.key, pinIndex.size);

  return (
    <div className={`pane-bar pane-bar-focus-${activeSection}`}>
      <div
        ref={(el) => {
          tabsRowRef.current = el;
          stripRef.current = el;
        }}
        className={`tabs tabs-harbor ${activeSection !== "tabs" ? "pane-section-dim" : ""}`}
      >
        {blob && (
          <span
            ref={blobElRef}
            className="tab-harbor-blob"
            aria-hidden
            // Slide via transform (GPU-composited, no per-frame layout) rather
            // than `left`, which would relayout+repaint the strip every frame.
            style={{ transform: `translateX(${blob.left}px)`, width: blob.width }}
          />
        )}
        {drawn.map((group, run) => {
          // An empty stack is not a stack: a strip with nothing idle says so by
          // having no Idle chip at all, rather than an empty one to read past.
          // Same for every kind of document you haven't opened. (Those runs are
          // dropped from `drawn` above, so the pile counts what is on screen.)
          const open = group.label == null || openStacks[group.key] !== false;
          const folded = group.tabs.length - group.shown.length;
          const pin = pinIndex.get(group.key);
          return (
            <div
              className={`tab-group tab-group-${group.key} ${
                group.label && !open ? "tab-group-folded" : ""
              }`}
              key={group.key}
              {...{ [GROUP_ATTR]: group.key }}
            >
              {/* One explicit line between adjacent runs. */}
              {run > 0 && <span className="tab-group-sep" aria-hidden />}
              {group.label && pin != null && (
                <>
                  <span className="tab-pin-anchor" {...{ [ANCHOR_ATTR]: group.key }} aria-hidden />
                  <span
                    className={`tab-stack ${
                      // Folded away the tab you are looking at: the chip says so,
                      // rather than holding that one tab out beside a count that
                      // then disagreed with it.
                      !open && group.tabs.some((t) => t.id === activeTabId)
                        ? "tab-stack-current"
                        : ""
                    }`}
                    data-stack-chip=""
                    style={{
                      ["--pin-left" as string]: "0px",
                      zIndex: pin + 2,
                    }}
                  >
                    <button
                      type="button"
                      className="tab-stack-face"
                      aria-expanded={open}
                      title={
                        open
                            ? `${group.tabs.length} ${group.label.toLowerCase()} — click to fold`
                            : `${folded} ${group.label.toLowerCase()} folded — click to open`
                      }
                      onClick={() => onToggleStack(group.key)}
                    >
                      {group.icon ?? <span className="tab-stack-dot" aria-hidden />}
                      <span className="tab-stack-name">{group.label}</span>
                      <span className="tab-stack-count">{group.tabs.length}</span>
                      <ChevronIcon size={8} className="tab-stack-chevron" />
                    </button>
                  </span>
                </>
              )}
              {group.shown.map((tab) => (
                <div
                  key={tab.id}
                  data-flip-id={tab.id}
                  ref={tab.id === activeTabId ? (activeTabElRef as React.RefObject<HTMLDivElement>) : undefined}
                  className={`tab ${isNewTab(tab.id) ? "tab-new" : ""} ${tab.id === activeTabId ? "tab-active" : ""} ${
                    tab.type === "chat" && tab.unread ? "tab-unread" : ""
                  } ${tab.type !== "terminal" ? "tab-doc" : isAgentTab(tab) ? "tab-agent" : ""} ${
                    tab.id === flashTabId ? "tab-flash" : ""
                  } ${tab.id === stripDrag.dragId ? "tab-dragging" : ""}`}
                  {...stripDrag.itemProps(tab.id)}
                  onClick={(e) => onSelectTab(tab.id, e.detail)}
                  onContextMenu={(e) => onTabContextMenu(e, tab)}
                  title={tabTitle(tab)}
                >
                  {tab.type === "terminal" ? (
                    <>
                      {Boolean(tab.multiplexCount && tab.multiplexCount > 1) && (
                        <span className="tab-multiplex-icon" aria-hidden>▦</span>
                      )}
                      <span
                        className={`tab-status tab-status-${tabState(tab)} ${
                          (tabRing?.(tab) ?? tab.unread) ? "tab-status-unread" : ""
                        }`}
                        aria-hidden
                      />
                    </>
                  ) : tab.type === "pr" ? (
                    <PullRequestIcon size={12} className="tab-pr-icon" />
                  ) : tab.type === "ticket" ? (
                    <TrackerIcon id={tab.source} size={12} className="tab-ticket-icon" />
                  ) : tab.type === "commit" ? (
                    <CommitIcon size={12} className="tab-commit-icon" />
                  ) : tab.type === "branch" ? (
                    <GitBranchIcon size={12} className="tab-branch-icon" />
                  ) : tab.type === "agent" ? (
                    <AgentIcon id={tab.agent} size={12} className="tab-branch-icon" />
                  ) : tab.type === "chat" ? (
                    <TeamIcon size={12} className="tab-chat-icon" />
                  ) : tab.type === "collab" ? (
                    <TeamIcon size={12} className="tab-collab-icon" />
                  ) : tab.type === "review" ? (
                    <PullRequestIcon size={12} className="tab-pr-icon" />
                  ) : tab.type === "shared-project" ? (
                    <LiveShareIcon size={12} className="tab-collab-icon" />
                  ) : tab.type === "preview" ? (
                    <GlobeIcon size={12} className="tab-preview-icon" />
                  ) : tab.type === "mcp" ? (
                    <PlugIcon size={12} className="tab-mcp-icon" />
                  ) : tab.type === "claim" ? (
                    <ClaimIcon size={12} className="tab-claim-icon" />
                  ) : tab.type === "agents" ? (
                    <AgentsIcon size={12} className="tab-mcp-icon" />
                  ) : (
                    <>
                      {tab.type === "file" && collabPaths.has(tab.file.path) && (
                        <TeamIcon size={11} className="tab-collab-icon" />
                      )}
                      {tab.type === "file" && tab.file.external != null && (
                        <span className="tab-external">●</span>
                      )}
                    </>
                  )}
                  {tab.type === "terminal" && renamingTabId === tab.id ? (
                    <input
                      className="tab-rename-input"
                      ref={renameInputRef}
                      value={renameDraft}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onRenameDraftChange(e.target.value)}
                      onBlur={onCommitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); onCommitRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
                      }}
                    />
                  ) : (
                    <span
                      className="tab-title"
                      title={tab.type === "terminal" ? "Double-click or right-click to rename" : undefined}
                    >
                      {tabText(tab)}
                    </span>
                  )}
                  {/* Non-default accounts only — the point is telling two
                      sessions of the same CLI apart. */}
                  {tab.type === "terminal" && tab.profile && (
                    <span
                      className="tab-profile"
                      title={`Running under the "${profileLabels?.[tab.profile] ?? tab.profile}" account`}
                    >
                      {profileLabels?.[tab.profile] ?? tab.profile}
                    </span>
                  )}
                  {tab.type === "terminal" && Boolean(tab.multiplexCount && tab.multiplexCount > 1) && (
                    <span className="tab-multiplex-count" title={`${tab.multiplexCount} panes`}>
                      {tab.multiplexCount}
                    </span>
                  )}
                  {hints.has(tab.id) && (
                    <span className="tab-hint">{hints.get(tab.id)}</span>
                  )}
                  <span
                    className="tab-close"
                    title="Close tab"
                    onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                  >
                    <CloseIcon size={12} />
                  </span>
                </div>
              ))}
              {run === drawn.length - 1 && <span className="tab-strip-tail" aria-hidden />}
            </div>
          );
        })}
      </div>

      <Rail
        label="SHELLS"
        chips={shellChips}
        summary={<TerminalIcon size={11} className="run-chip-shell-dot" />}
        open={shellMenuOpen}
        setOpen={setShellMenuOpen}
        dim={activeSection !== "shells"}
      />
      <Rail
        label="RUNS"
        chips={runChips}
        summary={runSummary}
        open={runMenuOpen}
        setOpen={setRunMenuOpen}
        dim={activeSection !== "runs"}
      />

      <div className="pane-actions">
        {stripTabs.length > 4 && (
          <Button icon title="All open tabs" onClick={onOpenAllTabs}>⌄</Button>
        )}

        {/* Live-share a file */}
        {isRelayConnectedWithPeers && activeFileKind && (
          <div className="cli-menu-anchor">
            <button
              className={`btn btn-icon-text ${isSharedFile ? "btn-accent" : ""}`}
              title="Edit this file live with a teammate"
              onClick={() => setShareMenuOpen(!shareMenuOpen)}
            >
              <LiveShareIcon size={14} />
              {isSharedFile ? "Sharing" : "Share live"}
            </button>
            {shareMenuOpen && (
              <div className="cli-menu" onMouseLeave={() => setShareMenuOpen(false)}>
                {relayMembers.map((m) => (
                  <div key={m.id} className="cli-item" onClick={() => { setShareMenuOpen(false); onShareFile(m.id, m.name); }}>
                    <span><TeamIcon size={15} className="cli-icon" /> {m.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Share whole project */}
        {isRelayConnectedWithPeers && (
          <div className="cli-menu-anchor">
            <button
              className={`btn btn-icon-text ${relayMembers.some((m) => isProjectShared(m.id)) ? "btn-accent" : ""}`}
              title="Share this whole project live — teammates open any file to edit together"
              onClick={() => setShareProjectMenuOpen(!shareProjectMenuOpen)}
            >
              <LiveShareIcon size={14} />
              {relayMembers.some((m) => isProjectShared(m.id)) ? "Sharing project" : "Share project"}
            </button>
            {shareProjectMenuOpen && (
              <div className="cli-menu" onMouseLeave={() => setShareProjectMenuOpen(false)}>
                {relayMembers.map((m) => {
                  const already = isProjectShared(m.id);
                  return (
                    <div
                      key={m.id}
                      className={`cli-item ${already ? "cli-item-done" : ""}`}
                      onClick={() => { if (already) return; setShareProjectMenuOpen(false); onShareProject(m.id, m.name); }}
                    >
                      <span><TeamIcon size={15} className="cli-icon" /> {m.name}</span>
                      {already && <span className="cli-item-tick">✓ sharing</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Preview/Source toggle for document tabs */}
        {activeFileKind && ["markdown", "html", "notebook", "sheet", "json"].includes(activeFileKind) && (
          <Button onClick={onToggleView}>
            {activeFileView === "preview" ? "Source" : "Preview"}
          </Button>
        )}

        {/* Terminal actions — only when a terminal tab is active */}
        {isTerminalTab && (
          <>
            <Button icon title="Clear scrollback" onClick={onClearScrollback}>⌫</Button>
            <Button icon title="Hard reset" onClick={onHardReset}>↺</Button>
          </>
        )}

        {/* New terminal / agent launcher */}
        <div className="cli-menu-anchor">
          <Button
            title="New terminal / agent"
            onClick={() => {
              if (!cliMenuOpen) { onRefreshInstalled(); onRefreshUpdates(); }
              setCliMenuOpen(!cliMenuOpen);
            }}>
            ＋ ▾
          </Button>
          {cliMenuOpen && (
            <div className="cli-menu" onMouseLeave={() => setCliMenuOpen(false)}>
              <div className="cli-item" onClick={() => { setCliMenuOpen(false); onNewShell(); }}>
                <span><TerminalIcon size={15} className="cli-icon" /> Shell</span>
              </div>
              <div className="cli-item" onClick={() => { setCliMenuOpen(false); onOpenPreview(); }}>
                <span><GlobeIcon size={15} className="cli-icon" /> Preview</span>
              </div>
              <div className="cli-sep" />
              {/* Non-default accounts only. */}
              {account && (
                <div className="cli-account-banner" title="Change it from the account chip in the status bar">
                  launching as <strong>{account.label}</strong>
                </div>
              )}
              {AGENT_CLIS.map((cli) => (
                <div key={cli.id} className="cli-item" onClick={() => { setCliMenuOpen(false); onLaunchCli(cli); }}>
                  <span><AgentIcon id={cli.id} size={15} className="cli-icon" /> {cli.name}</span>
                  {/* This account has no login for that CLI yet. Still
                      launchable — that is how you sign in. */}
                  {installed[cli.bin] && account?.missing.includes(cli.id) && (
                    <span className="cli-signin" title={`${account.label} has no ${cli.name} login yet — launching will ask you to sign in`}>
                      sign in
                    </span>
                  )}
                  {!installed[cli.bin] && <span className="cli-install">install</span>}
                  {installed[cli.bin] && cliUpdates[cli.bin]?.hasUpdate && (
                    <span
                      className="cli-update"
                      title={`${cliUpdates[cli.bin]?.installed} → ${cliUpdates[cli.bin]?.latest} — click to update`}
                      onClick={(e) => { e.stopPropagation(); setCliMenuOpen(false); onRunCliUpdate(cli, e); }}
                    >
                      ⇡ {cliUpdates[cli.bin]?.latest}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoized: the bar only re-renders when its props actually change — not on
// every ProjectView tick from the stats sampler.
export const PaneBar = memo(PaneBarImpl);

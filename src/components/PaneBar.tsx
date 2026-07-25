import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import {
  AgentIcon,
  CloseIcon,
  CommitIcon,
  GitBranchIcon,
  GlobeIcon,
  LiveShareIcon,
  PullRequestIcon,
  TeamIcon,
  TerminalIcon,
  TrackerIcon,
} from "./icons";
import type { AgentCli } from "../projects";
import { AGENT_CLIS } from "../projects";
import type { TabDrag } from "../tabDrag";
import type {
  SubTab,
  TermSubTab,
  RailChip,
} from "./ProjectView";

export type { SubTab, RailChip };

// ── Label helpers ────────────────────────────────────────────────────────────

function tabDisplayLabel(t: SubTab): string {
  switch (t.type) {
    case "terminal": return t.customTitle ?? t.title;
    case "file": return t.file.name;
    case "pr": return `#${t.pr.number} ${t.pr.title}`;
    case "ticket": return `${t.ticket.id} ${t.ticket.title}`;
    case "commit": return `${t.short} ${t.subject}`;
    case "branch": return t.branch.branch;
    case "agent": return `${t.agent} · ${t.digest?.branch ?? t.cwd.split("/").filter(Boolean).pop() ?? t.agent}`;
    case "chat": return t.name;
    case "collab": return t.name;
    case "review": return t.review.title;
    case "shared-project": return t.name;
    case "preview": return previewLabel(t.url);
  }
}

function previewLabel(url: string): string {
  if (!url) return "Preview";
  try { const u = new URL(url); return `${u.host}${u.pathname === "/" ? "" : u.pathname}`; }
  catch { return url; }
}

function tabTitle(tab: SubTab): string {
  switch (tab.type) {
    case "terminal": return `${tab.notice ? `${tab.notice}\n` : ""}${tab.command ?? ""} — ${tab.cwd}`;
    case "pr": return `${tab.pr.title} — ${tab.pr.url}`;
    case "ticket": return `${tab.ticket.id} — ${tab.ticket.title}\n${tab.ticket.url}`;
    case "commit": return `${tab.short} — ${tab.subject}`;
    case "branch": return `${tab.branch.branch}\n${tab.branch.worktree ?? "no worktree"}`;
    case "agent": return `${tab.agent} workspace\n${tab.cwd}`;
    case "chat": return tab.peer === null ? "Team chat — everyone on the relay" : `Direct chat with ${tab.name}`;
    case "collab": return `${tab.name} — live, owned by ${tab.ownerName}`;
    case "review": return `Review from ${tab.review.from}: ${tab.review.title}`;
    case "shared-project": return `${tab.name} — shared live by ${tab.ownerName}`;
    case "preview": return tab.url || "Preview";
    case "file": return tab.file.path;
  }
}

function tabText(tab: SubTab): string {
  switch (tab.type) {
    case "terminal": return tab.customTitle ?? tab.title;
    case "pr": return `#${tab.pr.number} ${tab.pr.title}`;
    case "ticket": return `${tab.ticket.id} ${tab.ticket.title}`;
    case "commit": return `${tab.short} ${tab.subject}`;
    case "branch": return tab.branch.branch;
    case "agent": return tabDisplayLabel(tab);
    case "chat": return tab.name;
    case "collab": return `${tab.name} ⇄`;
    case "review": return tab.review.title;
    case "shared-project": return tab.name;
    case "preview": return previewLabel(tab.url);
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
  tabGroups: SubTab[][];
  stripTabs: SubTab[];
  activeTabId: string | null;
  flashTabId: string | null;
  renamingTabId: string | null;
  renameDraft: string;
  collabPaths: Set<string>;
  isAgentTab: (t: SubTab) => t is TermSubTab;
  tabState: (t: TermSubTab) => "working" | "waiting" | "idle" | "ended";
  /** Drag-to-reorder, one per tab group (agents, docs) — index-aligned with tabGroups. */
  groupDrags: TabDrag[];
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
  onRunCliUpdate: (cli: AgentCli, e: React.MouseEvent) => void;
  onRefreshInstalled: () => void;
  onRefreshUpdates: () => void;
  onOpenAllTabs: (e: React.MouseEvent) => void;
  activeTabElRef: React.RefObject<HTMLDivElement | null>;
}

// ── PaneBar ───────────────────────────────────────────────────────────────────

function PaneBarImpl({
  tabGroups, groupDrags, stripTabs, activeTabId, flashTabId, renamingTabId, renameDraft,
  collabPaths, isAgentTab, tabState,
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
  onShareFile, onShareProject, onOpenPreview, onLaunchCli, onRunCliUpdate,
  onRefreshInstalled, onRefreshUpdates, onOpenAllTabs,
  activeTabElRef,
}: PaneBarProps) {
  // Harbor tabs: the docked active-tab shape is a single element that glides
  // between tabs, staying fused with the editor surface below, instead of the
  // .tab-active styling teleporting. We measure the active tab (via the ref the
  // container already threads to it) and animate a blob to its box.
  const tabsRowRef = useRef<HTMLDivElement>(null);
  const blobElRef = useRef<HTMLSpanElement>(null);
  const [blob, setBlob] = useState<{ left: number; width: number } | null>(null);

  const measureBlob = () => {
    const el = (activeTabElRef as React.RefObject<HTMLDivElement>)?.current;
    const row = tabsRowRef.current;
    if (!el || !row) { setBlob((b) => (b === null ? b : null)); return; }
    // offsetLeft is in the row's content coordinates (the row is the positioned
    // offsetParent), so the absolutely-positioned blob scrolls with the tabs.
    const next = { left: el.offsetLeft, width: el.offsetWidth };
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

  return (
    <div className={`pane-bar pane-bar-focus-${activeSection}`}>
      <div
        ref={tabsRowRef}
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
        {tabGroups.map((group, gi) =>
          group.length === 0 ? null : (
            <div className="tab-group" key={gi}>
              {group.map((tab) => (
                <div
                  key={tab.id}
                  ref={tab.id === activeTabId ? (activeTabElRef as React.RefObject<HTMLDivElement>) : undefined}
                  className={`tab ${tab.id === activeTabId ? "tab-active" : ""} ${
                    tab.type === "chat" && tab.unread ? "tab-unread" : ""
                  } ${tab.type !== "terminal" ? "tab-doc" : isAgentTab(tab) ? "tab-agent" : ""} ${
                    tab.id === flashTabId ? "tab-flash" : ""
                  } ${tab.id === groupDrags[gi].dragId ? "tab-dragging" : ""}`}
                  {...groupDrags[gi].itemProps(tab.id)}
                  onClick={(e) => onSelectTab(tab.id, e.detail)}
                  onContextMenu={(e) => onTabContextMenu(e, tab)}
                  title={tabTitle(tab)}
                >
                  {tab.type === "terminal" ? (
                    <span
                      className={`tab-status tab-status-${tabState(tab)} ${tab.unread ? "tab-status-unread" : ""}`}
                      aria-hidden
                    />
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
                      autoFocus
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
                  <span
                    className="tab-close"
                    title="Close tab"
                    onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                  >
                    <CloseIcon size={12} />
                  </span>
                </div>
              ))}
            </div>
          ),
        )}
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
          <button className="btn-icon" title="All open tabs" onClick={onOpenAllTabs}>⌄</button>
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
          <button className="btn" onClick={onToggleView}>
            {activeFileView === "preview" ? "Source" : "Preview"}
          </button>
        )}

        {/* Terminal actions — only when a terminal tab is active */}
        {isTerminalTab && (
          <>
            <button className="btn-icon" title="Clear scrollback" onClick={onClearScrollback}>⌫</button>
            <button className="btn-icon" title="Hard reset" onClick={onHardReset}>↺</button>
          </>
        )}

        {/* New terminal / agent launcher */}
        <div className="cli-menu-anchor">
          <button
            className="btn"
            title="New terminal / agent"
            onClick={() => {
              if (!cliMenuOpen) { onRefreshInstalled(); onRefreshUpdates(); }
              setCliMenuOpen(!cliMenuOpen);
            }}
          >
            ＋ ▾
          </button>
          {cliMenuOpen && (
            <div className="cli-menu" onMouseLeave={() => setCliMenuOpen(false)}>
              <div className="cli-item" onClick={() => { setCliMenuOpen(false); onNewShell(); }}>
                <span><TerminalIcon size={15} className="cli-icon" /> Shell</span>
              </div>
              <div className="cli-item" onClick={() => { setCliMenuOpen(false); onOpenPreview(); }}>
                <span><GlobeIcon size={15} className="cli-icon" /> Preview</span>
              </div>
              <div className="cli-sep" />
              {AGENT_CLIS.map((cli) => (
                <div key={cli.id} className="cli-item" onClick={() => { setCliMenuOpen(false); onLaunchCli(cli); }}>
                  <span><AgentIcon id={cli.id} size={15} className="cli-icon" /> {cli.name}</span>
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

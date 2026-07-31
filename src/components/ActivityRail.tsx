import { memo } from "react";
import {
  AgentsIcon,
  DiffIcon,
  FilesIcon,
  GitBranchIcon,
  IssueIcon,
  PlugIcon,
  PullRequestIcon,
  ResearchIcon,
  ServersIcon,
  SettingsIcon,
  SidebarIcon,
  TasksIcon,
  TeamIcon,
} from "./icons";
import type { SideTab } from "./ProjectView";

interface RailTab {
  key: SideTab;
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
  title: string;
}

/** The rail in three groups: the project itself, what's changing and being
 *  reviewed, and who is doing the work. Icons in one column read as one
 *  undifferentiated list — the grouping is what makes the rail scannable at
 *  icon width, where there is no room for headings.
 *
 *  Files and Servers share a group. A group of one buys nothing: it can't be
 *  told from its neighbour by density, so all it contributes is the 10px of
 *  boundary padding — whitespace with no rule in it and no run of icons on
 *  either side to explain it. Both answer "what is in this project", which is
 *  a real enough pairing to sit under one boundary. */
const RAIL_GROUPS: { name: string; tabs: RailTab[] }[] = [
  {
    name: "Project",
    tabs: [
      { key: "files", Icon: FilesIcon, title: "Components & files" },
      {
        key: "servers",
        Icon: ServersIcon,
        title: "Servers — every component you can run, start and manage",
      },
    ],
  },
  {
    name: "Source control & Review",
    tabs: [
      { key: "changes", Icon: DiffIcon, title: "Session changes" },
      { key: "git", Icon: GitBranchIcon, title: "Git — branches, commits, worktrees, PRs" },
      { key: "prs", Icon: PullRequestIcon, title: "Pull requests — every open project, one list" },
      { key: "trackers", Icon: IssueIcon, title: "Issues — GitHub, Linear, …" },
    ],
  },
  {
    name: "Agents",
    tabs: [
      // Agents leads its own group: it is the one the group is named for and
      // the one that carries the pending badge, so it should be the icon the
      // eye lands on when it crosses the boundary.
      { key: "agents", Icon: AgentsIcon, title: "Agents" },
      { key: "tasks", Icon: TasksIcon, title: "Tasks — one-shot agent jobs" },
      // With the agents rather than with the issues: research is what agents
      // produce, and its list is a worklist of theirs, not a queue of yours.
      {
        key: "research",
        Icon: ResearchIcon,
        title: "Research — what's been investigated, and what shipped from it",
      },
      { key: "team", Icon: TeamIcon, title: "Team — relay, chat, notifications" },
    ],
  },
];

/** Tools sits at the foot of the rail with Settings rather than in the Agents
 *  group. It is configuration — which MCP servers exist and what they expose —
 *  not a place work shows up, so it belongs with the other thing you go to set
 *  something up and then leave. It still opens a panel, so unlike Settings and
 *  the sidebar toggle it keeps the tab behaviour: hover-to-peek, click to pin,
 *  and the active/pinned markers. */
const TOOLS_TAB: RailTab = {
  key: "tools",
  Icon: PlugIcon,
  title: "Tools — MCP servers your agents can reach, from every CLI",
};

interface ActivityRailProps {
  sideTab: SideTab;
  /** The panel is showing — by hover or by pin. Drives the active marker. */
  open: boolean;
  /** Latched open by a click or Cmd+B, so it outlives the pointer. */
  pinned: boolean;
  changeBadge: number;
  /** Servers currently up. A count rather than a dot: "is anything running"
   *  and "did I leave four of them running" are different questions. */
  serversBadge: number;
  /** PRs waiting on this user, across every open project. */
  prsBadge: number;
  tasksBadge: number;
  pendingCount: number;
  urgentCount: number;
  teamBadge: number;
  relayRole: "off" | "host" | "client";
  onSelectTab: (tab: SideTab) => void;
  onHoverTab: (tab: SideTab) => void;
  /** The pointer left an icon before the dwell elapsed — abandon the pending
   *  open. Does not disturb a panel that is already out. */
  onHoverCancel: () => void;
  /** `prompt` retracts on a short clock instead of the full grace period —
   *  for when the pointer is demonstrably done with the tabs. */
  onHoverLeave: (prompt?: boolean) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

function ActivityRailImpl({
  sideTab,
  open,
  pinned,
  changeBadge,
  serversBadge,
  prsBadge,
  tasksBadge,
  pendingCount,
  urgentCount,
  teamBadge,
  relayRole,
  onSelectTab,
  onHoverTab,
  onHoverCancel,
  onHoverLeave,
  onOpenSettings,
  onToggleSidebar,
}: ActivityRailProps) {
  const tabButton = (t: RailTab, groupName?: string) => (
    <button
      key={t.key}
      className={`rail-btn ${open && sideTab === t.key ? "rail-btn-active" : ""} ${
        pinned && sideTab === t.key ? "rail-btn-pinned" : ""
      }`}
      /* No `title`. Hovering these now slides the panel out, and the
         native tooltip fires on the same gesture — it lands on top of
         the thing it was describing, a second later and less useful,
         because the panel's own header already says what it is. The
         label survives for screen readers, which get no panel. */
      aria-label={groupName ? `${groupName} — ${t.title}` : t.title}
      onClick={() => onSelectTab(t.key)}
      /* The dwell is armed on the icon and disarmed the moment the
         pointer leaves it. Without the leave half, the gap between rail
         groups — which belongs to no button — would let a pointer that
         has already moved on still trip the timer it left behind. */
      onMouseEnter={() => onHoverTab(t.key)}
      onMouseLeave={onHoverCancel}
      onFocus={() => onHoverTab(t.key)}
      onBlur={onHoverCancel}
    >
      <t.Icon size={22} />
      {t.key === "changes" && changeBadge > 0 && (
        <span className="rail-badge">{Math.min(changeBadge, 99)}</span>
      )}
      {t.key === "servers" && serversBadge > 0 && (
        <span className="rail-badge rail-badge-live">{Math.min(serversBadge, 99)}</span>
      )}
      {t.key === "prs" && prsBadge > 0 && (
        <span className="rail-badge rail-badge-urgent">{Math.min(prsBadge, 99)}</span>
      )}
      {t.key === "tasks" && tasksBadge > 0 && (
        <span className="rail-badge">{Math.min(tasksBadge, 99)}</span>
      )}
      {t.key === "agents" && pendingCount > 0 && (
        <span className={`rail-badge ${urgentCount > 0 ? "rail-badge-urgent" : ""}`}>
          {pendingCount}
        </span>
      )}
      {t.key === "team" && teamBadge > 0 && (
        <span className="rail-badge rail-badge-urgent">{Math.min(teamBadge, 99)}</span>
      )}
      {t.key === "team" && relayRole !== "off" && (
        <span
          className="rail-conn"
          title={relayRole === "host" ? "Hosting a relay" : "Connected to a relay"}
        />
      )}
    </button>
  );

  return (
    // Leaving the rail starts the retract clock; the panel itself cancels it
    // when the pointer arrives there. The two are edge-to-edge, so there is no
    // dead gap between them to fall through.
    <div className="rail" onMouseLeave={() => onHoverLeave()}>
      {RAIL_GROUPS.map((group) => (
        <div className="rail-group" key={group.name} role="group" aria-label={group.name}>
          {group.tabs.map((t) => tabButton(t, group.name))}
        </div>
      ))}
      <div className="rail-spacer" />
      {/* Tools rides directly above Settings, flush with it rather than inside
          a group of its own: the spacer is already the boundary, and a group
          wrapper would only push it away from the button it belongs with. It
          keeps a tab's hover-to-peek because it still opens a panel. */}
      {tabButton(TOOLS_TAB)}
      {/* These two keep their tooltips — they open no panel, so the tooltip is
          still the only thing that names them. Reaching either one means you
          have left the tabs, so it starts the retract: the panel is on its way
          out before the tooltip appears where the panel used to be. */}
      <button
        className="rail-btn"
        title="Settings (Cmd+,)"
        onClick={onOpenSettings}
        onMouseEnter={() => onHoverLeave(true)}
      >
        <SettingsIcon size={22} />
      </button>
      <button
        className={`rail-btn ${pinned ? "rail-btn-pinned" : ""}`}
        title={pinned ? "Unpin sidebar (Cmd+B)" : "Pin sidebar open (Cmd+B)"}
        onClick={onToggleSidebar}
        onMouseEnter={() => onHoverLeave(true)}
      >
        <SidebarIcon size={22} collapsed={!pinned} />
      </button>
    </div>
  );
}

// Memoized: the rail only re-renders when a badge, the active tab, the open or
// pinned state, or the relay role changes — not on every ProjectView tick.
export const ActivityRail = memo(ActivityRailImpl);

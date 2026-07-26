import { memo } from "react";
import {
  AgentsIcon,
  DiffIcon,
  FilesIcon,
  GitBranchIcon,
  IssueIcon,
  PullRequestIcon,
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

/** The rail in three groups: what you're editing, what's changing and being
 *  reviewed, and who is doing the work. Seven icons in one column read as one
 *  undifferentiated list — the grouping is what makes the rail scannable at
 *  icon width, where there is no room for headings. */
const RAIL_GROUPS: { name: string; tabs: RailTab[] }[] = [
  {
    name: "Files & Assets",
    tabs: [{ key: "files", Icon: FilesIcon, title: "Components & files" }],
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
      { key: "tasks", Icon: TasksIcon, title: "Tasks — one-shot agent jobs" },
      { key: "agents", Icon: AgentsIcon, title: "Agents" },
      { key: "team", Icon: TeamIcon, title: "Team — relay, chat, notifications" },
    ],
  },
];

interface ActivityRailProps {
  sideTab: SideTab;
  collapsed: boolean;
  changeBadge: number;
  /** PRs waiting on this user, across every open project. */
  prsBadge: number;
  tasksBadge: number;
  pendingCount: number;
  urgentCount: number;
  teamBadge: number;
  relayRole: "off" | "host" | "client";
  onSelectTab: (tab: SideTab) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

function ActivityRailImpl({
  sideTab,
  collapsed,
  changeBadge,
  prsBadge,
  tasksBadge,
  pendingCount,
  urgentCount,
  teamBadge,
  relayRole,
  onSelectTab,
  onOpenSettings,
  onToggleSidebar,
}: ActivityRailProps) {
  return (
    <div className="rail">
      {RAIL_GROUPS.map((group) => (
        <div className="rail-group" key={group.name} role="group" aria-label={group.name}>
          {group.tabs.map((t) => (
            <button
              key={t.key}
              className={`rail-btn ${!collapsed && sideTab === t.key ? "rail-btn-active" : ""}`}
              title={`${group.name} — ${t.title}`}
              onClick={() => onSelectTab(t.key)}
            >
              <t.Icon size={22} />
              {t.key === "changes" && changeBadge > 0 && (
                <span className="rail-badge">{Math.min(changeBadge, 99)}</span>
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
          ))}
        </div>
      ))}
      <div className="rail-spacer" />
      <button
        className="rail-btn"
        title="Settings (Cmd+,)"
        onClick={onOpenSettings}
      >
        <SettingsIcon size={22} />
      </button>
      <button
        className="rail-btn"
        title="Toggle sidebar (Cmd+B)"
        onClick={onToggleSidebar}
      >
        <SidebarIcon size={22} collapsed={collapsed} />
      </button>
    </div>
  );
}

// Memoized: the rail only re-renders when a badge, the active tab, the
// collapsed state, or the relay role changes — not on every ProjectView tick.
export const ActivityRail = memo(ActivityRailImpl);

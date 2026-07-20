// Issues sidebar section: ONE unified list across every connected tracker,
// grouped by unified status (in progress / todo / backlog / done), with
// source pills up top acting as filters. Connecting a tracker happens in
// Settings → Integrations, not here. A ticket can be handed to an agent —
// an already-open agent terminal, or a fresh one started in a worktree on
// the ticket's branch. It stops there on purpose — no auto-commit, no
// auto-PR.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import { agentMenuItems } from "../agentMenu";
import {
  STATUS_LABELS,
  STATUS_ORDER,
  TRACKERS,
  ticketBranch,
  ticketContext,
  ticketWorktree,
  unifiedStatus,
} from "../trackers";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { PlayIcon, TrackerIcon } from "./icons";

export interface AgentTarget {
  tabId: string;
  title: string;
  ptyId: number;
  /** Registry id of the CLI running in it, for its brand mark. */
  agentId: string;
  /** Directory it is working in — what tells two claudes apart. */
  dir: string;
}

interface TicketsPanelProps {
  components: { label: string; path: string }[];
  /** Agent terminals currently open in this project — send targets. */
  agentTargets: AgentTarget[];
  /** Create/reuse the ticket's worktree and start an agent there. Owned by
   *  ProjectView so the ticket tab and this panel do the identical thing. */
  onStartWork: (ticket: ipc.TicketInfo, agentId?: string) => Promise<void>;
  /** Which agent CLIs are on PATH — the list offered for a new agent. */
  installed: Record<string, boolean>;
  /** Type `text` into an already-running agent terminal and focus it. */
  onSendToAgent: (target: AgentTarget, text: string) => void;
  /** Open the ticket as a tab in the main area. */
  onOpenTicket: (ticket: ipc.TicketInfo, source: string) => void;
  /** Jump to Settings → Integrations (where sources get connected). */
  onOpenIntegrations: () => void;
}

interface SourcedTicket extends ipc.TicketInfo {
  source: string;
}

/** Last good fetch per repo, kept for the run. Refetching a tracker takes a
 *  network round trip (and a `gh` subprocess), and throwing the previous
 *  result away first meant every refresh — including simply re-entering the
 *  panel — flashed an empty list and lost scroll position. Render the cache
 *  immediately, then replace it when the real answer lands. */
const LAST_GOOD = new Map<
  string,
  { tickets: SourcedTicket[]; connected: string[]; worktrees: ipc.WorktreeInfo[] }
>();

export function TicketsPanel({
  components,
  agentTargets,
  onStartWork,
  installed,
  onSendToAgent,
  onOpenTicket,
  onOpenIntegrations,
}: TicketsPanelProps) {
  const [repos, setRepos] = useState<ipc.RepoInfo[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  const [tickets, setTickets] = useState<SourcedTicket[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  /** True only when there is nothing cached to show — a genuinely empty
   *  first load, not a background refresh. */
  const [cold, setCold] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [offSources, setOffSources] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const menu = useContextMenu();

  const key = components.map((c) => c.path).join("\n");

  useEffect(() => {
    void ipc
      .gitRepos(components.map((c) => [c.label, c.path] as [string, string]))
      .then((r) => {
        setRepos(r);
        setRepo((cur) => (cur && r.some((x) => x.path === cur) ? cur : (r[0]?.path ?? null)));
      })
      .catch(() => setRepos([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Paint whatever we last saw for this repo before any request goes out.
  useEffect(() => {
    if (!repo) return;
    const cached = LAST_GOOD.get(repo);
    if (cached) {
      setTickets(cached.tickets);
      setConnected(cached.connected);
      setWorktrees(cached.worktrees);
      setCold(false);
    } else {
      setCold(true);
    }
  }, [repo]);

  const load = useCallback(async () => {
    if (!repo) return;
    setBusy(true);
    try {
      void ipc
        .gitWorktrees(repo)
        .then((w) => {
          setWorktrees(w);
          const prev = LAST_GOOD.get(repo);
          if (prev) LAST_GOOD.set(repo, { ...prev, worktrees: w });
        })
        .catch(() => {});
      const all: SourcedTicket[] = [];
      const on: string[] = [];
      const errs: string[] = [];
      await Promise.all(
        TRACKERS.map(async (p) => {
          const avail = await p.available(repos.map((r) => r.path));
          if (!avail.ok) return;
          on.push(p.id);
          try {
            const list = await p.fetch(repo);
            all.push(...list.map((t) => ({ ...t, source: p.id })));
          } catch (err) {
            errs.push(`${p.name}: ${String(err)}`);
          }
        }),
      );
      setConnected(on);
      setErrors(errs);
      // A failed tracker returns nothing; keeping the stale list beats
      // blanking the panel because the network blipped. Only replace when
      // this fetch actually produced something, or when everything that is
      // connected genuinely reported zero.
      if (all.length > 0 || errs.length === 0) {
        setTickets(all);
        LAST_GOOD.set(repo, {
          tickets: all,
          connected: on,
          worktrees: LAST_GOOD.get(repo)?.worktrees ?? [],
        });
      }
      setCold(false);
    } finally {
      setBusy(false);
    }
  }, [repo, repos]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener("canopy:trackers-changed", onChange);
    return () => window.removeEventListener("canopy:trackers-changed", onChange);
  }, [load]);

  const startNew = async (ticket: SourcedTicket, agentId?: string) => {
    if (starting) return;
    setStarting(ticket.id);
    try {
      await onStartWork(ticket, agentId);
      if (repo) void ipc.gitWorktrees(repo).then(setWorktrees).catch(() => {});
    } finally {
      setStarting(null);
    }
  };

  /** ▶ opens the shared agent menu: running agents, then New agent ›. */
  const openSendMenu = (e: React.MouseEvent, ticket: SourcedTicket) => {
    const wt = ticketWorktree(ticket, worktrees);
    menu.open(
      e,
      agentMenuItems({
        targets: agentTargets,
        installed,
        newLabel: wt ? `New agent in ${wt.branch}` : `New agent in ${ticketBranch(ticket)}`,
        onSend: (t) => onSendToAgent(t, ticketContext(ticket)),
        onStart: (agentId) => void startNew(ticket, agentId),
      }),
    );
  };

  const visible = tickets.filter((t) => !offSources.has(t.source));
  const groups = STATUS_ORDER.map((status) => ({
    status,
    tickets: visible.filter((t) => unifiedStatus(t) === status),
  })).filter((g) => g.tickets.length > 0);

  const sourceName = (id: string) => TRACKERS.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="side-panel">
      {menu.menu && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.items} onClose={menu.close} />
      )}
      <div className="side-panel-head">
        <span>Issues</span>
        <button
          className={`btn-icon ${busy ? "ticket-refreshing" : ""}`}
          title={busy ? "Refreshing…" : "Refresh"}
          onClick={() => void load()}
        >
          ↻
        </button>
      </div>

      {/* Source pills: which trackers feed this list. Click to filter one out.
          Connecting new sources lives in Settings → Integrations. */}
      <div className="ticket-pills">
        {connected.map((id) => (
          <button
            key={id}
            className={`ticket-pill ${offSources.has(id) ? "" : "ticket-pill-on"}`}
            title={`${sourceName(id)} — click to ${offSources.has(id) ? "show" : "hide"}`}
            onClick={() =>
              setOffSources((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          >
            <TrackerIcon id={id} size={11} />
            {sourceName(id)}
          </button>
        ))}
        <button
          className="ticket-pill ticket-pill-add"
          title="Connect a tracker (Settings → Integrations)"
          onClick={onOpenIntegrations}
        >
          ＋
        </button>
      </div>

      {/* Repo picker as chips, matching the Git panel — the app should have
          one way to choose which repo a panel is acting on, not two. */}
      {repos.length > 1 && (
        <div className="git-repos">
          {repos.map((r) => (
            <button
              key={r.path}
              className={`git-repo-chip ${r.path === repo ? "git-repo-chip-on" : ""}`}
              title={`${r.path}\ncomponents: ${r.components.join(", ")}`}
              onClick={() => setRepo(r.path)}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}

      {errors.map((e) => (
        <div key={e} className="tree-empty">
          {e}
        </div>
      ))}

      {connected.length === 0 && !busy && !cold ? (
        <div className="tree-empty">
          No trackers connected.{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenIntegrations();
            }}
          >
            Connect one in Settings → Integrations.
          </a>
        </div>
      ) : groups.length === 0 ? (
        <div className="tree-empty">{cold && busy ? "Loading issues…" : "No active issues."}</div>
      ) : (
        groups.map((g) => (
          <div key={g.status}>
            <div className="ticket-state-head">
              {STATUS_LABELS[g.status]}
              <span className="badge">{g.tickets.length}</span>
            </div>
            {g.tickets.map((t) => {
              const wt = ticketWorktree(t, worktrees);
              return (
                <div
                  key={`${t.source}-${t.id}`}
                  className="ticket-row"
                  title={`${t.id} — ${t.title}\n${sourceName(t.source)} · ${t.state}\n${t.url}${
                    wt ? `\nworktree: ${wt.path}` : ""
                  }`}
                  onClick={() => onOpenTicket(t, t.source)}
                >
                  <div className="ticket-main">
                    <TrackerIcon
                      id={t.source}
                      size={12}
                      className={`ticket-src ticket-src-${t.source}`}
                    />
                    <span className="ticket-id">{t.id}</span>
                    <span className="ticket-title">{t.title}</span>
                  </div>
                  <div className="ticket-meta">
                    {wt && (
                      <span className="ticket-wt" title={`Worktree exists: ${wt.branch}`}>
                        ⑂ {wt.dirty > 0 ? `±${wt.dirty}` : "clean"}
                      </span>
                    )}
                    {t.assignee && (
                      <span className={`ticket-assignee ${t.mine ? "ticket-mine" : ""}`}>
                        {t.mine ? "you" : t.assignee}
                      </span>
                    )}
                    <button
                      className="icon-btn ticket-start"
                      title="Send to an agent — an open one, or a new one in a worktree"
                      disabled={starting != null}
                      onClick={(e) => {
                        e.stopPropagation();
                        openSendMenu(e, t);
                      }}
                    >
                      <PlayIcon size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

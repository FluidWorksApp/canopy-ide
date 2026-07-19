// Issue Trackers sidebar section: one collapsible group per provider from
// the trackers.ts registry (GitHub by default, Linear once connected, more
// later). Read-only rows cross-referenced against local worktrees; clicking
// ▶ on a ticket creates/reuses a worktree on its branch and launches an
// agent with the ticket as opening context. It stops there on purpose — no
// auto-commit, no auto-PR.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import {
  TRACKERS,
  setTrackerKey,
  ticketBranch,
  ticketCommand,
  ticketWorktree,
  trackerKey,
  type TrackerProvider,
} from "../trackers";
import { PlayIcon } from "./icons";

interface TicketsPanelProps {
  components: { label: string; path: string }[];
  /** Launch a terminal running `command` in `cwd`, titled `title`. */
  onStartTicket: (cwd: string, command: string, title: string) => void;
  onNotice: (msg: string) => void;
}

interface ProviderState {
  ok: boolean;
  reason?: string;
  tickets: ipc.TicketInfo[];
  error?: string;
}

export function TicketsPanel({ components, onStartTicket, onNotice }: TicketsPanelProps) {
  const [repos, setRepos] = useState<ipc.RepoInfo[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  const [byProvider, setByProvider] = useState<Record<string, ProviderState>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

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

  const load = useCallback(async () => {
    if (!repo) return;
    setBusy(true);
    try {
      // Worktrees once, for the in-progress cross-reference on every row.
      void ipc.gitWorktrees(repo).then(setWorktrees).catch(() => setWorktrees([]));
      const results = await Promise.all(
        TRACKERS.map(async (p): Promise<[string, ProviderState]> => {
          const avail = await p.available(repos.map((r) => r.path));
          if (!avail.ok) return [p.id, { ok: false, reason: avail.reason, tickets: [] }];
          try {
            return [p.id, { ok: true, tickets: await p.fetch(repo) }];
          } catch (err) {
            return [p.id, { ok: true, tickets: [], error: String(err) }];
          }
        }),
      );
      setByProvider(Object.fromEntries(results));
    } finally {
      setBusy(false);
    }
  }, [repo, repos]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async (ticket: ipc.TicketInfo) => {
    if (!repo || starting) return;
    setStarting(ticket.id);
    try {
      const existing = ticketWorktree(ticket, worktrees);
      if (existing) {
        onStartTicket(existing.path, ticketCommand(ticket), ticket.id);
        return;
      }
      const branch = ticketBranch(ticket);
      const path = `${repo}-wt-${branch.replace(/\//g, "-")}`;
      const branches = await ipc.gitBranches(repo).catch(() => [] as ipc.BranchInfo[]);
      const exists = branches.some((b) => b.name === branch);
      await ipc.gitWorktreeAdd(repo, path, branch, !exists);
      await ipc.workspaceAdd(path).catch(() => {});
      await ipc.gitWorktrees(repo).then(setWorktrees).catch(() => {});
      onStartTicket(path, ticketCommand(ticket), ticket.id);
    } catch (err) {
      onNotice(`Couldn't start work on ${ticket.id}: ${String(err)}`);
    } finally {
      setStarting(null);
    }
  };

  const connectUI = (p: TrackerProvider) => (
    <div className="tracker-connect">
      <p>{p.config!.help}</p>
      <div className="tracker-connect-row">
        <input
          type="password"
          placeholder={p.config!.placeholder}
          value={keyDrafts[p.id] ?? ""}
          onChange={(e) => setKeyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
        />
        <button
          className="btn btn-accent"
          disabled={!(keyDrafts[p.id] ?? "").trim()}
          onClick={() => {
            setTrackerKey(p.id, (keyDrafts[p.id] ?? "").trim());
            setKeyDrafts((d) => ({ ...d, [p.id]: "" }));
            void load();
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );

  const rows = (p: TrackerProvider, st: ProviderState) => {
    if (st.error) return <div className="tree-empty">{st.error}</div>;
    if (st.tickets.length === 0 && !busy)
      return <div className="tree-empty">No active tickets.</div>;
    // Group by human state name, in first-seen order (the fetches are already
    // sorted by recency/board order from the tracker).
    const groups = new Map<string, ipc.TicketInfo[]>();
    for (const t of st.tickets) {
      const g = groups.get(t.state) ?? [];
      g.push(t);
      groups.set(t.state, g);
    }
    return [...groups.entries()].map(([state, tickets]) => (
      <div key={state}>
        <div className="ticket-state-head">
          {state}
          <span className="badge">{tickets.length}</span>
        </div>
        {tickets.map((t) => {
          const wt = ticketWorktree(t, worktrees);
          return (
            <div
              key={`${p.id}-${t.id}`}
              className="ticket-row"
              title={`${t.id} — ${t.title}\n${t.url}${wt ? `\nworktree: ${wt.path}` : ""}`}
              onClick={() => {
                void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                  openUrl(t.url),
                );
              }}
            >
              <div className="ticket-main">
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
                  title={
                    wt
                      ? `Open agent in existing worktree (${wt.branch})`
                      : `Create worktree ${ticketBranch(t)} and start an agent on this ticket`
                  }
                  disabled={starting != null}
                  onClick={(e) => {
                    e.stopPropagation();
                    void start(t);
                  }}
                >
                  <PlayIcon size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    ));
  };

  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <span>Issue trackers</span>
        <button className="btn-icon" title="Refresh" onClick={() => void load()}>
          ↻
        </button>
      </div>
      {repos.length > 1 && (
        <select
          className="ticket-repo-select"
          value={repo ?? ""}
          title="Repository new worktrees are created in (and whose GitHub issues show)"
          onChange={(e) => setRepo(e.target.value || null)}
        >
          {repos.map((r) => (
            <option key={r.path} value={r.path}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {TRACKERS.map((p) => {
        const st = byProvider[p.id];
        return (
          <div key={p.id} className="tracker-section">
            <div className="side-panel-head">
              <span>{p.name}</span>
              {st?.ok && trackerKey(p.id) && (
                <button
                  className="btn-icon"
                  title={`Disconnect ${p.name} (removes the locally stored key)`}
                  onClick={() => {
                    setTrackerKey(p.id, "");
                    void load();
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {!st ? (
              <div className="tree-empty">…</div>
            ) : st.ok ? (
              rows(p, st)
            ) : st.reason === "connect" && p.config ? (
              connectUI(p)
            ) : (
              <div className="tree-empty">{st.reason}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

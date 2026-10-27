// The live team board: every agent in flight across this window's projects —
// what it is doing, whether it is working, what it holds, what it is touching,
// whether its last turn has a receipt — and the heads-ups Canopy has passed
// between them (src/awareness). The "what is everyone's agent doing right now"
// view: a PM can see two agents are both in checkout before code is wasted.
//
// Data, all read-only here: the same session/claim hooks as the Agents page,
// the ledger (`awareness` notes Canopy wrote, `receipt` entries another
// feature writes — absent is fine), and, on request, the cloud workspaces'
// rosters through the mesh-jobs coordinator.
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { basename } from "../paths";
import { getSettings, subscribeSettings, updateSettings } from "../settings";
import { LIFE_META } from "../../shared/agentLife";
import { agentDisplayName, type TabName } from "../agentDisplayName";
import { useAgentSessions, workingOnNow, type SessionRow } from "../agentSessions";
import { nodeLabel } from "../meshLinks";
import { claimLabel } from "../claims";
import { ledgerRoot, queryLedger, subscribeLedger, type LedgerEntry } from "../ledger";
import {
  awarenessStatus,
  hotspotsForRepo,
  subscribeAwarenessStatus,
  type AwarenessData,
  type AwarenessState,
} from "../awareness/engine";
import { cloudRosters, type CloudRoster } from "../awareness/roster";
import type { Hotspot } from "../awareness/hotspots";
import { AgentIcon, TerminalIcon } from "./icons";
import { Button, Switch } from "./ui";
import { statusLine } from "../awareness/statusLine";
import "./teamBoard.css";

export interface TeamBoardProps {
  active: boolean;
  allProjects: { name: string; roots: string[] }[];
  onJumpToPty?: (ptyId: number) => void;
  tabNames?: Map<number, TabName>;
}

const ago = (ms: number) => {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

/** A receipt is another feature's entry; read only what is plausibly there. */
function receiptLabel(entry: LedgerEntry): string {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const word = [entry.status, data.verdict, data.state, data.status].find(
    (v): v is string => typeof v === "string" && !!v.trim(),
  );
  return word ?? "recorded";
}

function labelFor(row: SessionRow, tabNames?: Map<number, TabName>) {
  return nodeLabel({
    name: row.session.name,
    agentLabel: row.agent?.label,
    ptyId: row.session.id,
    tabTitle: agentDisplayName({
      tab: tabNames?.get(row.session.id),
      agentLabel: row.agent?.label,
      sessionTitle: row.session.title,
    }),
    branch: row.digest?.branch,
  });
}

const RISK_LABEL: Record<string, string> = {
  conflict: "may conflict",
  low: "worth knowing",
  none: "fyi",
};

export function TeamBoard({ active, allProjects, onJumpToPty, tabNames }: TeamBoardProps) {
  const [stats, setStats] = useState<ipc.SessionStats[]>([]);
  useEffect(() => {
    if (!active) return;
    void ipc.ptyStats().then(setStats).catch(() => {});
    let cancelled = false;
    let un: (() => void) | undefined;
    void ipc.onPtyStats((all) => setStats(all)).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [active]);

  const roots = useMemo(() => allProjects.flatMap((p) => p.roots), [allProjects]);
  const { agentSessions, claims, lifeOf } = useAgentSessions({
    visible: active,
    roots,
    stats,
    liveSessionIds: [],
  });

  const [enabled, setEnabled] = useState(() => getSettings().awarenessEnabled);
  const [overrides, setOverrides] = useState(() => getSettings().awarenessHotspots);
  useEffect(
    () =>
      subscribeSettings(() => {
        setEnabled(getSettings().awarenessEnabled);
        setOverrides(getSettings().awarenessHotspots);
      }),
    [],
  );
  const [status, setStatus] = useState<AwarenessState>(() => awarenessStatus());
  useEffect(() => {
    setStatus(awarenessStatus());
    return subscribeAwarenessStatus(() => setStatus(awarenessStatus()));
  }, [enabled]);

  // Every live agent's repository, by the ledger's canonical root — where its
  // receipts and the notes about it are filed.
  const cwds = useMemo(
    () => [...new Set(agentSessions.map((r) => r.session.cwd))].sort(),
    [agentSessions],
  );
  const [rootOf, setRootOf] = useState<Map<string, string>>(new Map());
  const cwdsKey = cwds.join("\n");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all(
      cwds.map(async (cwd) => [cwd, await ledgerRoot(cwd).catch(() => cwd)] as const),
    ).then((pairs) => {
      if (!cancelled) setRootOf(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cwdsKey]);
  const repoRoots = useMemo(() => [...new Set(rootOf.values())].sort(), [rootOf]);
  const repoKey = repoRoots.join("\n");

  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  useEffect(() => {
    if (!active || !repoRoots.length) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      void Promise.all(
        repoRoots.map((root) =>
          queryLedger(root, { kinds: ["awareness", "receipt"], limit: 300 }).catch(() => []),
        ),
      ).then((lists) => {
        if (!cancelled) setEntries(lists.flat().sort((a, b) => b.ts - a.ts));
      });
    };
    load();
    const un = subscribeLedger("*", (e) => {
      if (e.kind === "awareness" || e.kind === "receipt") load();
    });
    return () => {
      cancelled = true;
      un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, repoKey]);

  const notes = useMemo(
    () => entries.filter((e): e is LedgerEntry<AwarenessData> => e.kind === "awareness"),
    [entries],
  );
  const receiptFor = (sessionId?: string) =>
    sessionId
      ? entries.find((e) => e.kind === "receipt" && e.ref?.kind === "session" && e.ref.id === sessionId)
      : undefined;
  const latestNoteFor = (sessionId?: string) =>
    sessionId ? notes.find((n) => n.data.to?.sessionId === sessionId) : undefined;

  const [hotspots, setHotspots] = useState<Record<string, { list: Hotspot[]; overridden: boolean }>>({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all(
      repoRoots.map(async (root) => [root, await hotspotsForRepo(root).catch(() => null)] as const),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, { list: Hotspot[]; overridden: boolean }> = {};
      for (const [root, h] of pairs) if (h) next[root] = h;
      setHotspots(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, repoKey, overrides]);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const saveOverride = (root: string, text: string | null) => {
    const next = { ...getSettings().awarenessHotspots };
    if (text === null) delete next[root];
    else next[root] = text.split("\n").map((l) => l.trim()).filter(Boolean);
    updateSettings({ awarenessHotspots: next });
    setEditing(null);
  };

  const [cloud, setCloud] = useState<CloudRoster[] | null | "loading">(null);

  return (
    <div className="tb">
      <div className="tb-status" role="status">
        <span className="tb-status-text">{statusLine(status)}</span>
        <span className="tb-switch">
          <span id="tb-switch-label">Tell agents about each other's changes</span>
          <Switch
            checked={enabled}
            onChange={(on) => updateSettings({ awarenessEnabled: on })}
            aria-labelledby="tb-switch-label"
          />
        </span>
      </div>

      <section className="agv-section" aria-labelledby="tb-inflight">
        <header className="agv-section-head">
          <h2 id="tb-inflight">In flight</h2>
          <span className="agv-section-note">{agentSessions.length} agent{agentSessions.length === 1 ? "" : "s"} across every open project</span>
        </header>
        {agentSessions.length === 0 ? (
          <p className="tb-empty">No agents are running in this window right now.</p>
        ) : (
          <table className="acp-table tb-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Doing</th>
                <th>Holds</th>
                <th>Touching</th>
                <th>Receipt</th>
                <th>Last heads-up</th>
              </tr>
            </thead>
            <tbody>
              {agentSessions.map((row) => {
                const life = lifeOf(row);
                const st = LIFE_META[life.state];
                const label = labelFor(row, tabNames);
                const held = claims.filter(
                  (c) => c.released_at_ms == null && c.pty_id === row.session.id,
                );
                const files = (row.digest?.files ?? []).slice(-4);
                const receipt = receiptFor(row.digest?.session_id);
                const note = latestNoteFor(row.digest?.session_id);
                return (
                  <tr key={row.session.id}>
                    <td>
                      <button
                        type="button"
                        className="tb-agent"
                        title={`${row.session.cwd}\nJump to this terminal`}
                        onClick={() => onJumpToPty?.(row.session.id)}
                      >
                        {row.agent?.id ? <AgentIcon id={row.agent.id} size={14} /> : <TerminalIcon size={13} />}
                        <span>{label.primary}</span>
                      </button>
                      <span className="acp-dim">{row.agent?.label ?? "terminal"} · {basename(row.session.cwd)}</span>
                    </td>
                    <td>
                      <span className={`acp-state ${st.cls}`} title={life.note}>{st.label}</span>
                    </td>
                    <td className="acp-prompt">{workingOnNow(row, tabNames) ?? <em>not said yet</em>}</td>
                    <td>{held.length ? held.map((c) => <span key={c.id} className="tb-chip" title={c.paths.join("\n")}>{claimLabel(c)}</span>) : <span className="acp-dim">nothing</span>}</td>
                    <td className="tb-files">{files.length ? files.map((f) => <span key={f} title={f}>{basename(f)}</span>) : <span className="acp-dim">no edits yet</span>}</td>
                    <td>{receipt ? <span className="tb-chip" title={receipt.subject ?? ""}>{receiptLabel(receipt)}</span> : <span className="acp-dim">none yet</span>}</td>
                    <td className="tb-note">{note ? <span title={`From ${note.data.from?.name ?? "another agent"}, ${ago(note.ts)}`}>{note.data.note}</span> : <span className="acp-dim">none</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="agv-section" aria-labelledby="tb-feed">
        <header className="agv-section-head">
          <h2 id="tb-feed">What agents were told</h2>
          <span className="agv-section-note">written by your brain when one agent's change touches another's work</span>
        </header>
        {notes.length === 0 ? (
          <p className="tb-empty">Nothing yet. When an agent finishes a change that overlaps another agent's files, the note it was sent shows up here.</p>
        ) : (
          <ul className="tb-feed">
            {notes.slice(0, 20).map((n) => (
              <li key={n.id} className={`tb-feed-item tb-risk-${n.data.risk}`}>
                <div className="tb-feed-head">
                  <strong>{n.data.to?.name ?? "An agent"}</strong>
                  <span className="acp-dim">
                    {" "}was told about {n.data.from?.name ?? "another agent"}'s change
                    {n.data.files?.length ? ` to ${n.data.files.slice(0, 3).map((f) => basename(f)).join(", ")}` : ""}
                  </span>
                  <span className="tb-chip">{n.data.kind === "hotspot" ? "hotspot" : RISK_LABEL[n.data.risk] ?? n.data.risk}</span>
                  <span className="acp-dim tb-when">{ago(n.ts)}{n.data.delivered ? "" : " · not delivered"}</span>
                </div>
                <p className="tb-feed-note">{n.data.note}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agv-section" aria-labelledby="tb-hot">
        <header className="agv-section-head">
          <h2 id="tb-hot">Hotspots</h2>
          <span className="agv-section-note">files many changes pass through. When two agents touch one, the latest gets a claim and both are warned.</span>
        </header>
        {repoRoots.length === 0 ? (
          <p className="tb-empty">Hotspots appear for the repositories your agents are working in.</p>
        ) : (
          repoRoots.map((root) => {
            const h = hotspots[root];
            return (
              <div key={root} className="tb-repo">
                <div className="tb-repo-head">
                  <strong title={root}>{basename(root)}</strong>
                  <span className="acp-dim">{h?.overridden ? "your list" : "inferred from the last 30 days"}</span>
                  <Button size="sm" onClick={() => { setEditing(root); setDraft((h?.list ?? []).map((x) => x.path).join("\n")); }}>
                    Edit list
                  </Button>
                  {h?.overridden && (
                    <Button size="sm" onClick={() => saveOverride(root, null)}>Use inferred</Button>
                  )}
                </div>
                {editing === root ? (
                  <div className="tb-edit">
                    <label htmlFor={`tb-edit-${root}`}>One path per line, relative to the repository. A folder covers everything in it.</label>
                    <textarea id={`tb-edit-${root}`} rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="tb-edit-actions">
                      <Button size="sm" variant="accent" onClick={() => saveOverride(root, draft)}>Save</Button>
                      <Button size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : h?.list.length ? (
                  <div className="tb-hot-list">
                    {h.list.slice(0, 16).map((x) => (
                      <span key={x.path} className="tb-chip" title={x.reasons.join("; ")}>{x.path}</span>
                    ))}
                  </div>
                ) : (
                  <p className="tb-empty">{h ? "No hotspots found. Route tables, registries and config files still count when two agents touch them." : "Working it out…"}</p>
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="agv-section" aria-labelledby="tb-cloud">
        <header className="agv-section-head">
          <h2 id="tb-cloud">Cloud workspaces</h2>
          <span className="agv-section-note">agents running in your cloud workspaces and the ones teammates shared with you</span>
          <Button size="sm" onClick={() => { setCloud("loading"); void cloudRosters().then(setCloud); }} disabled={cloud === "loading"}>
            {cloud === "loading" ? "Checking…" : "Check now"}
          </Button>
        </header>
        {cloud === null ? (
          <p className="tb-empty">Not checked yet. Checking asks each workspace's service who is running.</p>
        ) : cloud === "loading" ? null : cloud.length === 0 ? (
          <p className="tb-empty">No cloud workspaces are reachable from this account.</p>
        ) : (
          <ul className="tb-feed">
            {cloud.map((w) => (
              <li key={w.id ?? w.name} className="tb-feed-item">
                <div className="tb-feed-head">
                  <strong>{w.name}</strong>
                  <span className="acp-dim">{w.online ? "online" : "offline"}</span>
                </div>
                {w.agents?.length ? (
                  w.agents.map((a) => (
                    <p key={a.ptyId} className="tb-feed-note">
                      {a.name ?? `agent #${a.ptyId}`}{a.agent ? ` (${a.agent})` : ""}: {a.task ?? "no task named"}
                      {a.files?.length ? (
                        <span className="acp-dim">
                          {" "}· edited {a.files.slice(0, 3).map((f) => f.path).join(", ")}
                          {a.files.length > 3 ? ` +${a.files.length - 3}` : ""}
                        </span>
                      ) : null}
                    </p>
                  ))
                ) : (
                  <p className="tb-feed-note acp-dim">{w.note ?? "No agents running."}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Servers: every component that has something to execute, and the state of each
// run — one list, no file tree to expand through. The files panel still shows a
// component's run commands next to its code, which is right when you are
// working *in* that component; this answers the other question, "what is up
// across the whole project, and what do I need to restart", without making you
// go looking component by component.
//
// It owns no server state. Rows are `groupServers()` output and every button
// calls back into ProjectView, which already runs the terminals — so a start
// here and a start from the files panel are the same start, on the same tab.
import { useState } from "react";
import { serverUrl, type ServerEntry, type ServerGroup } from "../servers";
import { principalAgent, type AgentRef } from "../workspaces";
import {
  CheckIcon,
  ChevronIcon,
  FailIcon,
  LiveDot,
  PlayIcon,
  RestartIcon,
  StopIcon,
  TerminalIcon,
} from "./icons";

interface ServersPanelProps {
  groups: ServerGroup[];
  /** Start a configured command that has no tab yet. */
  onStart: (path: string, entry: ServerEntry) => void;
  onRestart: (tabId: string) => void;
  onStop: (ptyId: number) => void;
  /** Bring the run's terminal to the front — its output is the real detail view. */
  onOpenRun: (tabId: string) => void;
  onOpenPreview: (url: string) => void;
  onNewTerminal: (path: string) => void;
  /** Bring an agent's terminal to the front, from the workspace row that names
   *  it. Given a PTY id, which is how an agent is addressed everywhere. */
  onOpenAgent: (ptyId: number) => void;
  /** Project settings, where run commands are added and edited. */
  onEdit: () => void;
}

/** What an agent's lifecycle state means, in the row's own words. */
const AGENT_STATE: Record<AgentRef["state"], string> = {
  working: "working now",
  waiting: "waiting on you",
  idle: "idle",
  ended: "finished",
  unknown: "here",
};

const STATE_TITLE: Record<ServerEntry["state"], string> = {
  running: "running",
  stopped: "not running",
  done: "finished",
  failed: "exited",
};

function StateMark({ state }: { state: ServerEntry["state"] }) {
  if (state === "running") return <LiveDot size={9} className="command-live-dot" />;
  if (state === "done") return <CheckIcon size={11} className="command-ok" />;
  if (state === "failed") return <FailIcon size={11} className="command-fail" />;
  return <PlayIcon size={11} className="command-play" />;
}

/** One command in one directory. The same row whether that directory is the
 *  component itself or its copy on a branch — a run is a run. */
function RunRow({
  entry: e,
  dir,
  onStart,
  onRestart,
  onStop,
  onOpenRun,
  onOpenPreview,
}: {
  entry: ServerEntry;
  dir: string;
} & Pick<
  ServersPanelProps,
  "onStart" | "onRestart" | "onStop" | "onOpenRun" | "onOpenPreview"
>) {
  const running = e.state === "running";
  const start = () => (e.tabId ? onRestart(e.tabId) : onStart(dir, e));
  return (
    <div
      className={`command-run-row ${running ? "command-running" : ""} ${
        e.state === "done"
          ? "command-done"
          : e.state === "failed"
            ? "command-failed"
            : ""
      }`}
      title={`${STATE_TITLE[e.state]}${
        e.state === "failed" ? ` ${e.exitCode ?? "?"}` : ""
      } — ${e.command || e.name}`}
      // Clicking the row opens the run's terminal, which is where its output
      // is. A row that has never run has no terminal to open, so the click
      // starts it instead.
      onClick={() => (e.tabId ? onOpenRun(e.tabId) : start())}
    >
      <StateMark state={e.state} />
      <span className="command-run-name">{e.name}</span>
      {e.adhoc && (
        <span
          className="servers-adhoc"
          title="Started outside this project's run commands — by an agent, or from a terminal"
        >
          ad-hoc
        </span>
      )}
      {/* The port is the reason most of these are running, so it is on the row
          rather than in a tooltip — and it opens the page rather than merely
          naming it. */}
      {e.ports.map((p) => (
        <span
          key={p}
          className="term-port servers-port"
          title={`Open ${serverUrl(p)} in a preview tab`}
          onClick={(ev) => {
            ev.stopPropagation();
            onOpenPreview(serverUrl(p));
          }}
        >
          :{p}
        </span>
      ))}
      {e.state === "failed" && <span className="command-exit-code">{e.exitCode}</span>}
      <span className="command-run-actions" onClick={(ev) => ev.stopPropagation()}>
        {running ? (
          <>
            <button
              className="icon-btn"
              title="Restart"
              onClick={() => e.tabId && onRestart(e.tabId)}
            >
              <RestartIcon size={14} />
            </button>
            <button
              className="icon-btn icon-btn-danger"
              title="Stop"
              onClick={() => e.ptyId != null && onStop(e.ptyId)}
            >
              <StopIcon size={13} />
            </button>
          </>
        ) : (
          <button
            className="icon-btn"
            title={e.tabId ? "Run again" : "Run"}
            onClick={start}
          >
            {e.tabId ? <RestartIcon size={14} /> : <PlayIcon size={12} />}
          </button>
        )}
      </span>
    </div>
  );
}

export function ServersPanel({
  groups,
  onStart,
  onRestart,
  onStop,
  onOpenRun,
  onOpenPreview,
  onNewTerminal,
  onOpenAgent,
  onEdit,
}: ServersPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  /** Explicit opens/closes only. Anything absent falls back to "open if
   *  something is happening in there", so the list follows the work without
   *  overriding a choice you made. */
  const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({});
  const toggleWs = (path: string, busy = false) =>
    setWsOpen((prev) => ({ ...prev, [path]: !(prev[path] ?? busy) }));

  const live = groups.reduce((n, g) => n + g.running, 0);

  return (
    <div className="servers-panel">
      <div className="side-panel-head">
        <span>Servers</span>
        <span className="servers-head-actions">
          {live > 0 && <span className="servers-live">{live} running</span>}
          <button className="btn-icon" title="Edit run commands" onClick={onEdit}>
            ⚙
          </button>
        </span>
      </div>

      {groups.length === 0 && (
        <div className="servers-empty">
          <p>Nothing to run yet.</p>
          <p>
            Run commands live on a component — a dev server, a build, a worker. Add one and
            it shows up here.
          </p>
          <button className="btn-mini" onClick={onEdit}>
            Add a run command
          </button>
        </div>
      )}

      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.path);
        const stoppable = g.entries.filter((e) => e.state === "running" && e.ptyId != null);
        const startable = g.entries.filter((e) => !e.adhoc && e.state !== "running");
        return (
          <div key={g.path} className="servers-group">
            <div
              className="component-header"
              title={g.path}
              onClick={() => toggle(g.path)}
            >
              <span className={`tree-chevron ${isCollapsed ? "" : "tree-chevron-open"}`}>
                <ChevronIcon />
              </span>
              <span className="component-title">{g.label}</span>
              {g.running > 0 && (
                <span className="servers-group-live" title={`${g.running} running`}>
                  {g.running}
                </span>
              )}
              <span className="component-actions">
                {stoppable.length > 0 ? (
                  <button
                    className="icon-btn icon-btn-danger"
                    title={`Stop all in ${g.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      for (const s of stoppable) if (s.ptyId != null) onStop(s.ptyId);
                    }}
                  >
                    <StopIcon size={13} />
                  </button>
                ) : (
                  startable.length > 0 && (
                    <button
                      className="icon-btn"
                      title={`Start all in ${g.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        for (const s of startable) onStart(g.path, s);
                      }}
                    >
                      <PlayIcon size={12} />
                    </button>
                  )
                )}
                <button
                  className="icon-btn"
                  title={`New terminal in ${g.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewTerminal(g.path);
                  }}
                >
                  <TerminalIcon size={13} />
                </button>
              </span>
            </div>

            {!isCollapsed && (
              <div className="component-commands">
                {g.entries.map((e) => (
                  <RunRow
                    key={e.key}
                    entry={e}
                    dir={g.path}
                    onStart={onStart}
                    onRestart={onRestart}
                    onStop={onStop}
                    onOpenRun={onOpenRun}
                    onOpenPreview={onOpenPreview}
                  />
                ))}

                {/* The same component on other branches. One line each until
                    you open it, so four workspaces cost four rows rather than
                    four headings and twelve commands. */}
                {g.workspaces.map((w) => {
                  // Open by default when something is happening in there —
                  // a live server or an agent — and closed otherwise. An
                  // explicit click overrides that either way.
                  const busy = w.running > 0 || w.agents.length > 0;
                  const open = wsOpen[w.path] ?? busy;
                  const wsStoppable = w.entries.filter(
                    (e) => e.state === "running" && e.ptyId != null,
                  );
                  const wsStartable = w.entries.filter(
                    (e) => !e.adhoc && e.state !== "running",
                  );
                  const wsPorts = [
                    ...new Set(w.entries.flatMap((e) => e.ports)),
                  ];
                  const lead = principalAgent(w.agents);
                  return (
                    <div key={w.path} className="ws-runs">
                      <div
                        className={`ws-run-head ${w.running > 0 ? "ws-run-live" : ""}`}
                        title={`${w.label}\n${w.path}`}
                        onClick={() => toggleWs(w.path, busy)}
                      >
                        <span
                          className={`tree-chevron ${open ? "tree-chevron-open" : ""}`}
                        >
                          <ChevronIcon />
                        </span>
                        <span className="ws-run-branch">{w.label}</span>
                        {/* Who is working in here, by name and by what they are
                            doing — the question a list of branches can't answer
                            on its own, and the thing you need before one agent
                            can ask another for its server. Clicking opens that
                            agent's terminal. */}
                        {lead && (
                          <span
                            className={`ws-run-agent ws-run-agent-${lead.state}`}
                            title={
                              `${lead.name} — ${AGENT_STATE[lead.state]}` +
                              (w.agents.length > 1
                                ? `\n+${w.agents.length - 1} more here: ${w.agents
                                    .slice(1)
                                    .map((a) => a.name)
                                    .join(", ")}`
                                : "") +
                              (lead.ptyId != null ? "\nClick to open its terminal" : "")
                            }
                            onClick={(ev) => {
                              ev.stopPropagation();
                              if (lead.ptyId != null) onOpenAgent(lead.ptyId);
                            }}
                          >
                            <span className="ws-run-agent-dot" />
                            {lead.name}
                            {w.agents.length > 1 && `+${w.agents.length - 1}`}
                          </span>
                        )}
                        {/* Only ever the port something is actually answering
                            on, read from the run itself. The lease this
                            workspace holds is plumbing — it is handed to the
                            process as env, and showing it before anything is
                            listening states a number as fact that no server
                            has agreed to. An app that reads its port from its
                            own config would make that a lie. */}
                        {wsPorts.map((p) => (
                          <span
                            key={p}
                            className="ws-run-port ws-run-port-live"
                            title={`Serving on ${p} — open its preview`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenPreview(serverUrl(p));
                            }}
                          >
                            :{p}
                          </span>
                        ))}
                        {w.running > 0 && (
                          <LiveDot size={8} className="command-live-dot" />
                        )}
                        <span className="ws-run-actions">
                          {wsStoppable.length > 0 ? (
                            <button
                              className="icon-btn icon-btn-danger"
                              title={`Stop all on ${w.label}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                for (const e of wsStoppable)
                                  if (e.ptyId != null) onStop(e.ptyId);
                              }}
                            >
                              <StopIcon size={12} />
                            </button>
                          ) : (
                            wsStartable.length > 0 && (
                              <button
                                className="icon-btn"
                                title={`Start all on ${w.label}`}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  for (const e of wsStartable) onStart(w.path, e);
                                }}
                              >
                                <PlayIcon size={11} />
                              </button>
                            )
                          )}
                          <button
                            className="icon-btn"
                            title={`New terminal on ${w.label}`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onNewTerminal(w.path);
                            }}
                          >
                            <TerminalIcon size={12} />
                          </button>
                        </span>
                      </div>
                      {open && (
                        <div className="ws-run-commands">
                          {w.entries.map((e) => (
                            <RunRow
                              key={e.key}
                              entry={e}
                              dir={w.path}
                              onStart={onStart}
                              onRestart={onRestart}
                              onStop={onStop}
                              onOpenRun={onOpenRun}
                              onOpenPreview={onOpenPreview}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

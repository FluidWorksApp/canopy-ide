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
  /** Project settings, where run commands are added and edited. */
  onEdit: () => void;
}

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

export function ServersPanel({
  groups,
  onStart,
  onRestart,
  onStop,
  onOpenRun,
  onOpenPreview,
  onNewTerminal,
  onEdit,
}: ServersPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

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
                {g.entries.map((e) => {
                  const running = e.state === "running";
                  const start = () =>
                    e.tabId ? onRestart(e.tabId) : onStart(g.path, e);
                  return (
                    <div
                      key={e.key}
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
                      // Clicking the row opens the run's terminal, which is
                      // where its output is. A row that has never run has no
                      // terminal to open, so the click starts it instead.
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
                      {/* The port is the reason most of these are running, so it
                          is on the row rather than in a tooltip — and it opens
                          the page rather than merely naming it. */}
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
                      {e.state === "failed" && (
                        <span className="command-exit-code">{e.exitCode}</span>
                      )}
                      <span
                        className="command-run-actions"
                        onClick={(ev) => ev.stopPropagation()}
                      >
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
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

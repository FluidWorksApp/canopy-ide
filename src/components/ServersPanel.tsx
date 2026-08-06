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
import { serverUrl, splitPorts, type ServerEntry, type ServerGroup } from "../servers";
import { AgentChip } from "./AgentChip";
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
import { Button } from "./ui";

interface ServersPanelProps {
  groups: ServerGroup[];
  /** Start a configured command that has no tab yet. */
  onStart: (path: string, entry: ServerEntry) => void;
  onRestart: (tabId: string, entry: ServerEntry) => void;
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
  const start = () => (e.tabId ? onRestart(e.tabId, e) : onStart(dir, e));
  const { shown, rest } = splitPorts(e.ports);
  // Whether this row's demoted ports are open. Per row, not per panel: the
  // question is about one process.
  const [portsOpen, setPortsOpen] = useState(false);
  const portChip = (p: number) => (
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
  );
  return (
    <div className="servers-run">
      <div
        className={`command-run-row ${running ? "command-running" : ""} ${
          e.state === "done"
            ? "command-done"
            : e.state === "failed"
              ? "command-failed"
              : ""
        }`}
        // The name is the first thing to give way when the panel is dragged
        // narrow and the chips are the next, so the tooltip carries both in
        // full: nothing the row drops is knowable only by widening the panel.
        title={`${e.name} — ${STATE_TITLE[e.state]}${
          e.state === "failed" ? ` ${e.exitCode ?? "?"}` : ""
        }${
          e.ports.length
            ? ` · listening on ${[...shown, ...rest].map((p) => `:${p}`).join(", ")}`
            : ""
        }\n${e.command || e.name}`}
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
            naming it. The ones the OS assigned itself sit behind the `+N` rather
            than pushing the run's own name off the row. */}
        {shown.map(portChip)}
        {rest.length > 0 && (
          <span
            className="term-port servers-port servers-port-more"
            title={
              portsOpen
                ? "Hide the ports the OS assigned"
                : `Also listening on ${rest.map((p) => `:${p}`).join(", ")}`
            }
            onClick={(ev) => {
              ev.stopPropagation();
              setPortsOpen((v) => !v);
            }}
          >
            {portsOpen ? "−" : `+${rest.length}`}
          </span>
        )}
        {e.state === "failed" && <span className="command-exit-code">{e.exitCode}</span>}
        <span className="command-run-actions" onClick={(ev) => ev.stopPropagation()}>
          {running ? (
            <>
              <Button icon
                title="Restart"
                onClick={() => e.tabId && onRestart(e.tabId, e)}>
                <RestartIcon size={14} />
              </Button>
              <Button icon variant="danger"
                title="Stop"
                onClick={() => e.ptyId != null && onStop(e.ptyId)}>
                <StopIcon size={13} />
              </Button>
            </>
          ) : (
            <Button icon
              title={e.tabId ? "Run again" : "Run"}
              onClick={start}>
              {e.tabId ? <RestartIcon size={14} /> : <PlayIcon size={12} />}
            </Button>
          )}
        </span>
      </div>
      {/* Revealed on their own line, never squeezed into the row: five chips in
          a 24px row is how the name got crushed in the first place. Growing the
          group is fine here — the user asked for it by clicking, so it is not a
          layout that shifts under the pointer. */}
      {portsOpen && rest.length > 0 && (
        <div className="servers-port-line">{rest.map(portChip)}</div>
      )}
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
          <Button icon title="Edit run commands" onClick={onEdit}>
            ⚙
          </Button>
        </span>
      </div>

      {groups.length === 0 && (
        <div className="servers-empty">
          <p>Nothing to run yet.</p>
          <p>
            Run commands live on a component — a dev server, a build, a worker. Add one and
            it shows up here.
          </p>
          <Button size="sm" onClick={onEdit}>
            Add a run command
          </Button>
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
              {/* Only while collapsed, which is the whole reason it exists: an
                  expanded group says the same thing with a live dot per row, and
                  saying it twice is what made the header read as busy. */}
              {isCollapsed && g.running > 0 && (
                <span className="servers-group-live" title={`${g.running} running`}>
                  {g.running}
                </span>
              )}
              <span className="component-actions">
                {stoppable.length > 0 ? (
                  <Button icon variant="danger"
                    title={`Stop all in ${g.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      for (const s of stoppable) if (s.ptyId != null) onStop(s.ptyId);
                    }}>
                    <StopIcon size={13} />
                  </Button>
                ) : (
                  startable.length > 0 && (
                    <Button icon
                      title={`Start all in ${g.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        for (const s of startable) onStart(g.path, s);
                      }}>
                      <PlayIcon size={12} />
                    </Button>
                  )
                )}
                <Button icon
                  title={`New terminal in ${g.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewTerminal(g.path);
                  }}>
                  <TerminalIcon size={13} />
                </Button>
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
                  // A branch line is a summary, so it takes only the ports
                  // somebody would open — the assigned ones are on the run's own
                  // row inside, and in this line's tooltip either way.
                  const wsAllPorts = [...new Set(w.entries.flatMap((e) => e.ports))];
                  const wsPorts = splitPorts(wsAllPorts).shown;
                  return (
                    <div key={w.path} className="ws-runs">
                      <div
                        className={`ws-run-head ${w.running > 0 ? "ws-run-live" : ""}`}
                        title={`${w.label}${
                          wsAllPorts.length
                            ? ` · listening on ${wsAllPorts
                                .sort((a, b) => a - b)
                                .map((p) => `:${p}`)
                                .join(", ")}`
                            : ""
                        }\n${w.path}`}
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
                        <AgentChip agents={w.agents} onOpen={onOpenAgent} />
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
                            <Button icon variant="danger"
                              title={`Stop all on ${w.label}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                for (const e of wsStoppable)
                                  if (e.ptyId != null) onStop(e.ptyId);
                              }}>
                              <StopIcon size={12} />
                            </Button>
                          ) : (
                            wsStartable.length > 0 && (
                              <Button icon
                                title={`Start all on ${w.label}`}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  for (const e of wsStartable) onStart(w.path, e);
                                }}>
                                <PlayIcon size={11} />
                              </Button>
                            )
                          )}
                          <Button icon
                            title={`New terminal on ${w.label}`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onNewTerminal(w.path);
                            }}>
                            <TerminalIcon size={12} />
                          </Button>
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

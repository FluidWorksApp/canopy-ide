// Agent management: one row per terminal session, named after the agent CLI
// detected inside its process tree, with CPU/memory for the runaway guard.
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { restoreCommand } from "../projects";
import type { PendingItem } from "../notifications";

const AGENT_PATTERN =
  /\b(claude|codex|aider|goose|gemini|opencode|amp|copilot|cursor-agent|qwen|droid)\b/i;

interface AgentsPanelProps {
  stats: ipc.SessionStats[];
  hookPath: string | null;
  pending?: PendingItem[];
  onJumpToTerminal?: (item: PendingItem) => void;
  /** Cross-session context sharing for this project. */
  roots: string[];
  shareContext: boolean;
  onShareContext: (on: boolean) => void;
  /** Session ids currently attached to a live terminal in this app run. */
  liveSessionIds?: string[];
  /** Reopen a past agent session: runs `cmd` in `cwd` as a new terminal. */
  onRestore?: (cwd: string, cmd: string, title: string, agentId: string) => void;
}

/** Compact relative age; the panel is narrow and "3h" beats a timestamp. */
const ago = (secs?: number) => {
  if (!secs) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

const fmtMem = (bytes: number) =>
  bytes > 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;

export function AgentsPanel({
  stats,
  hookPath,
  pending = [],
  onJumpToTerminal,
  roots,
  shareContext,
  onShareContext,
  liveSessionIds = [],
  onRestore,
}: AgentsPanelProps) {
  const [showHookHelp, setShowHookHelp] = useState(false);
  const [setupResult, setSetupResult] = useState<string | null>(null);
  const [digests, setDigests] = useState<ipc.SessionDigest[]>([]);
  const [showShared, setShowShared] = useState(false);
  const settings = getSettings();

  // Loaded regardless of the sharing toggle: these digests are also the crash
  // record that "Restore sessions" reads. Sharing is about what agents see of
  // each other; restore is about what the *user* lost when the IDE died.
  useEffect(() => {
    const load = () =>
      void ipc
        .sessionDigests()
        .then((d) =>
          setDigests(
            d.filter((x) =>
              roots.some((r) => x.cwd === r || (x.cwd ?? "").startsWith(r + "/")),
            ),
          ),
        )
        .catch(() => setDigests([]));
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [roots.join("\n")]);

  const autoSetup = async (agent: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setSetupResult(await invoke<string>("setup_agent_hooks", { agent }));
    } catch (err) {
      setSetupResult(String(err));
    }
  };

  // One row per terminal session, named after the agent running inside it.
  // "Running agents" and "Terminal sessions" used to be separate lists built
  // from the same `stats`, so a terminal running claude appeared twice with
  // near-identical numbers — the only difference being that the session total
  // also counts the shell wrapping the agent. The session is the real unit:
  // it's what you kill, and what has a directory.
  // Sessions that exist on disk but have no live terminal — what you lost when
  // the IDE or the machine died. Newest first: that's the one you were most
  // likely mid-thought in.
  //
  // Requires at least one prompt. A session where the agent started but was
  // never typed into has no conversation for the CLI to reopen — verified:
  // `claude --resume` on such an id answers "No conversation found with session
  // ID", because the transcript is only created once there is something to
  // record. Listing those would offer a button that can only fail, on sessions
  // with nothing worth restoring anyway.
  const restorable = useMemo(
    () =>
      digests
        .filter(
          (d) =>
            d.session_id &&
            !liveSessionIds.includes(d.session_id) &&
            (d.prompts?.length ?? 0) > 0,
        )
        .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)),
    [digests, liveSessionIds.join(",")],
  );

  const sessions = useMemo(
    () =>
      stats.map((s) => {
        const agent = s.procs.find(
          (p) => AGENT_PATTERN.test(p.name) || AGENT_PATTERN.test(p.cmd.split(" ")[0] ?? ""),
        );
        return {
          session: s,
          agent,
          // Where it's running — the thing that tells two `claude` rows apart.
          dir: (s.cwd || "").split("/").filter(Boolean).pop() ?? "",
        };
      }),
    [stats],
  );

  return (
    <div className="side-panel">
      {pending.length > 0 && (
        <>
          <div className="side-panel-head">
            <span>Needs your input</span>
            <span className="badge">{pending.length}</span>
          </div>
          {pending.map((item) => (
            <div
              key={item.key}
              className="pending-card"
              onClick={() => onJumpToTerminal?.(item)}
              title="Open the terminal running this agent"
            >
              {item.kind === "question" ? (
                <>
                  {(item.questions ?? []).map((q, i) => (
                    <div key={i} className="pending-question">
                      {q.header && <span className="pending-chip">{q.header}</span>}
                      <div className="pending-q-text">{q.question}</div>
                      <div className="pending-options">
                        {q.options.map((o) => (
                          <div key={o.label} className="pending-option">
                            <span className="pending-option-label">
                              {q.multiSelect ? "☐" : "○"} {o.label}
                            </span>
                            {o.description && (
                              <span className="pending-option-desc">{o.description}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="pending-q-text">🔔 {item.message}</div>
              )}
              <div className="pending-footer">
                <span className="event-time">{new Date(item.ts).toLocaleTimeString()}</span>
                <span className="pending-jump">answer in terminal ➜</span>
              </div>
            </div>
          ))}
        </>
      )}
      {/* Shared context — opt-in, and always inspectable. */}
      <div className="side-panel-head">
        <span>Shared context</span>
        <label className="share-toggle" title="Let agent sessions in this project see each other's recent work">
          <input
            type="checkbox"
            checked={shareContext}
            onChange={(e) => onShareContext(e.target.checked)}
          />
          <span>{shareContext ? "on" : "off"}</span>
        </label>
      </div>
      <div className="share-help">
        {shareContext ? (
          <>
            <p>
              Each session sees a short summary of what the <strong>other</strong> sessions in this
              project are doing, injected on its next prompt. It never sees its own work, and
              sessions outside this project are never included.
            </p>
            <button className="btn-mini" onClick={() => setShowShared((v) => !v)}>
              {showShared ? "Hide" : "Show"} what's shared ({digests.length})
            </button>
            {showShared &&
              (digests.length === 0 ? (
                <p className="share-none">
                  Nothing yet — a session appears here once it runs a prompt.
                </p>
              ) : (
                digests.map((d) => (
                  <div key={d.session_id} className="share-digest">
                    <div className="share-digest-head">
                      {d.cwd?.split("/").pop()}
                      {d.branch && <span className="share-branch">⎇ {d.branch}</span>}
                      <span className={d.idle ? "share-idle" : "share-active"}>
                        {d.idle ? "idle" : "active"}
                      </span>
                    </div>
                    {(d.prompts ?? []).slice(-2).map((p, i) => (
                      <div key={i} className="share-prompt">
                        {p}
                      </div>
                    ))}
                    {(d.files ?? []).length > 0 && (
                      <div className="share-files">{(d.files ?? []).slice(-6).join(", ")}</div>
                    )}
                  </div>
                ))
              ))}
          </>
        ) : (
          <p>
            Off. Sessions in this project can't see each other's work. Turning this on shares your
            prompts and edited file paths between them.
          </p>
        )}
      </div>

      {restorable.length > 0 && (
        <>
          <div className="side-panel-head">
            <span>Restore sessions</span>
            <span className="badge">{restorable.length}</span>
          </div>
          <div className="restore-help">
            Agent sessions from this project that aren't open right now. They survive
            a crash or restart — reopening runs the agent's own resume so it comes
            back with its history.
          </div>
          {restorable.map((d) => {
            const agentId = d.agent ?? "agent";
            // resume_cwd, not cwd: claude looks the conversation up under its
            // project root, so resuming from the subdirectory the agent ran in
            // reports "No conversation found".
            const runIn = d.resume_cwd || d.cwd || "";
            const cmd = d.resumable === false ? null : restoreCommand(agentId, d.session_id);
            const dir = runIn.split("/").filter(Boolean).pop() ?? "";
            const last = (d.prompts ?? []).at(-1);
            return (
              <div key={d.session_id} className="restore-row">
                <div className="restore-main">
                  <span className="agent-name">{agentId}</span>
                  {dir && (
                    <span className="agent-dir" title={runIn}>
                      {dir}
                    </span>
                  )}
                  {d.branch && <span className="share-branch">⎇ {d.branch}</span>}
                  <span className="agent-session">{ago(d.updated)}</span>
                </div>
                {/* The last prompt is how you recognise which session this was —
                    a bare uuid tells you nothing. */}
                <div className="restore-prompt">{last}</div>
                <div className="restore-actions">
                  {cmd ? (
                    <button
                      className="btn-mini"
                      title={cmd}
                      onClick={() => onRestore?.(runIn, cmd, agentId, agentId)}
                    >
                      Restore
                    </button>
                  ) : d.resumable === false ? (
                    // The agent wrote no transcript, so every --resume against
                    // this id fails. Say so rather than hand over a button whose
                    // only outcome is a red error in a terminal.
                    <span className="restore-unsupported" title={d.cwd}>
                      no saved history — can't resume
                    </span>
                  ) : (
                    <span
                      className="restore-unsupported"
                      title={`${agentId} cannot reopen a specific past session by id`}
                    >
                      no resume support
                    </span>
                  )}
                  <button
                    className="btn-mini"
                    title="Forget this session — removes it from this list"
                    onClick={() => {
                      void ipc.sessionForget(d.session_id).then(() =>
                        setDigests((prev) => prev.filter((x) => x.session_id !== d.session_id)),
                      );
                    }}
                  >
                    Forget
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      <div className="side-panel-head">
        <span>Sessions</span>
        <button
          className="btn-icon"
          title="How to hook up agent CLIs"
          onClick={() => setShowHookHelp((v) => !v)}
        >
          ?
        </button>
      </div>

      {showHookHelp && hookPath && (
        <div className="hook-help">
          <p>Stream tool-use events from agent CLIs into this panel:</p>
          <button className="btn btn-accent" onClick={() => void autoSetup("claude")}>
            Set up Claude Code hooks
          </button>
          {setupResult && <p className="hook-result">{setupResult}</p>}
          <p>
            Other CLIs: point any hook at appending single-line JSON to:
          </p>
          <code className="hook-path">{hookPath}</code>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="tree-empty">
          Nothing running. Launch <code>claude</code>, <code>codex</code>, etc. from the ＋
          menu or by right-clicking a component.
        </div>
      ) : (
        sessions.map(({ session: s, agent, dir }) => {
          const runaway =
            s.total_cpu > settings.runawayCpuPercent ||
            s.total_mem_bytes > settings.runawayMemBytes;
          return (
            <div key={s.id} className={`agent-row ${runaway ? "agent-runaway" : ""}`}>
              <div className="agent-main">
                <span className="agent-name">{agent?.name ?? s.title}</span>
                {dir && (
                  <span className="agent-dir" title={s.cwd}>
                    {dir}
                  </span>
                )}
                <span className="agent-session">term #{s.id}</span>
                {runaway && <span className="runaway-badge">runaway?</span>}
              </div>
              <div className="agent-stats">
                <span>{s.total_cpu.toFixed(0)}% cpu</span>
                <span>{fmtMem(s.total_mem_bytes)}</span>
                <span>{s.procs.length} procs</span>
                <button
                  className="btn-icon btn-danger"
                  title={`Kill terminal #${s.id}${agent ? ` and the ${agent.name} running in it` : ""}`}
                  onClick={() => void ipc.ptyKill(s.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

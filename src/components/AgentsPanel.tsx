// Agent management: one row per terminal session, named after the agent CLI
// detected inside its process tree, with CPU/memory for the runaway guard.
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
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
}

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
}: AgentsPanelProps) {
  const [showHookHelp, setShowHookHelp] = useState(false);
  const [setupResult, setSetupResult] = useState<string | null>(null);
  const [digests, setDigests] = useState<ipc.SessionDigest[]>([]);
  const [showShared, setShowShared] = useState(false);
  const settings = getSettings();

  // What sharing would actually expose, refreshed while the panel is open.
  // Nothing here should be invisible to the person whose prompts they are.
  useEffect(() => {
    if (!shareContext) return;
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
  }, [shareContext, roots.join("\n")]);

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

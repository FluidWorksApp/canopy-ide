// Agent management: detect agent CLIs inside terminal process trees, show
// CPU/memory (runaway guard), kill processes, and surface hook-bridge events.
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import type { AgentEventEntry } from "../types";
import type { PendingItem } from "../notifications";

const AGENT_PATTERN =
  /\b(claude|codex|aider|goose|gemini|opencode|amp|copilot|cursor-agent|qwen|droid)\b/i;

interface AgentsPanelProps {
  stats: ipc.SessionStats[];
  events: AgentEventEntry[];
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
  events,
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

  const agents = useMemo(
    () =>
      stats.flatMap((s) =>
        s.procs
          .filter((p) => AGENT_PATTERN.test(p.name) || AGENT_PATTERN.test(p.cmd.split(" ")[0] ?? ""))
          .map((p) => ({ session: s, proc: p })),
      ),
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
        <span>Running agents</span>
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

      {agents.length === 0 ? (
        <div className="tree-empty">
          No agents detected. Launch <code>claude</code>, <code>codex</code>, etc. in a
          terminal below.
        </div>
      ) : (
        agents.map(({ session, proc }) => (
          <div key={proc.pid} className="agent-row">
            <div className="agent-main">
              <span className="agent-name">{proc.name}</span>
              <span className="agent-session">term #{session.id}</span>
            </div>
            <div className="agent-stats">
              <span>{proc.cpu.toFixed(0)}% cpu</span>
              <span>{fmtMem(proc.mem_bytes)}</span>
              <button
                className="btn-icon btn-danger"
                title="Kill this agent process"
                onClick={() => void ipc.killProcess(proc.pid)}
              >
                ✕
              </button>
            </div>
          </div>
        ))
      )}

      <div className="side-panel-head">
        <span>Terminal sessions</span>
      </div>
      {stats.map((s) => {
        const runaway =
          s.total_cpu > settings.runawayCpuPercent ||
          s.total_mem_bytes > settings.runawayMemBytes;
        return (
          <div key={s.id} className={`agent-row ${runaway ? "agent-runaway" : ""}`}>
            <div className="agent-main">
              <span className="agent-name">{s.title}</span>
              {runaway && <span className="runaway-badge">runaway?</span>}
            </div>
            <div className="agent-stats">
              <span>{s.total_cpu.toFixed(0)}% cpu</span>
              <span>{fmtMem(s.total_mem_bytes)}</span>
              <span>{s.procs.length} procs</span>
              <button
                className="btn-icon btn-danger"
                title="Kill entire session"
                onClick={() => void ipc.ptyKill(s.id)}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}

      {events.length > 0 && (
        <>
          <div className="side-panel-head">
            <span>Hook events</span>
          </div>
          <div className="agent-events">
            {events.slice(-50).reverse().map((e, i) => (
              <EventRow key={events.length - i} entry={e} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EventRow({ entry }: { entry: AgentEventEntry }) {
  let label = entry.raw;
  try {
    const parsed = JSON.parse(entry.raw);
    // Support both our generic shape and Claude Code's native hook payload.
    const file = parsed.file ?? parsed.tool_input?.file_path;
    label = [
      parsed.agent ?? (parsed.session_id ? "claude" : undefined),
      parsed.event ?? parsed.hook_event_name,
      parsed.tool ?? parsed.tool_name,
      typeof file === "string" ? file.split("/").pop() : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  } catch {
    // show raw line
  }
  return (
    <div className="event-row" title={entry.raw}>
      <span className="event-time">
        {new Date(entry.ts).toLocaleTimeString()}
      </span>
      <span className="event-label">{label}</span>
    </div>
  );
}

// Agent management: one row per terminal session, named after the agent CLI
// detected inside its process tree, with CPU/memory for the runaway guard.
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { AGENT_CLIS, AGENT_PATTERN, restoreCommand } from "../projects";
import { restorableFrom } from "../restorable";
import { AgentIcon, RestartIcon, TerminalIcon, TrashIcon } from "./icons";
import type { PendingItem } from "../notifications";

interface AgentsPanelProps {
  stats: ipc.SessionStats[];
  hookPath: string | null;
  pending?: PendingItem[];
  onDismissPending?: (key: string) => void;
  /** Answer a single-select question by clicking its option in the panel. */
  onAnswer?: (item: PendingItem, optionIndex: number) => void;
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

/** Last thing the *human* typed. Hooks also record injected payloads
    (`<task-notification>…`, shared-context blocks) as prompts; an XML-ish
    blob identifies nothing, so skip anything that opens with a tag. */
const lastHumanPrompt = (prompts?: string[]) =>
  [...(prompts ?? [])]
    .reverse()
    .find((p) => p.trim().length > 0 && !p.trimStart().startsWith("<"));

const fmtMem = (bytes: number) =>
  bytes > 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;

/** One group. The panel used to be five identical full-width lists with
 *  identical headings, so "running now" and "restorable from before" looked
 *  the same — the indented body plus a rule is what separates them. */
function Section({
  title,
  count,
  tone,
  action,
  children,
}: {
  title: string;
  count?: number;
  tone?: "urgent" | "quiet";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`ap-section ${tone ? `ap-section-${tone}` : ""}`}>
      <div className="ap-head">
        <span className="ap-title">{title}</span>
        {count != null && count > 0 && <span className="badge">{count}</span>}
        <span className="ap-head-spacer" />
        {action}
      </div>
      <div className="ap-body">{children}</div>
    </div>
  );
}

export function AgentsPanel({
  stats,
  hookPath,
  pending = [],
  onDismissPending,
  onAnswer,
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

  // What the hook would actually inject — mirrors PEER_MAX_AGE_SECS in
  // canopy_hook.rs, which drops peers quiet for longer than this. The panel
  // must apply the same cutoff or it claims long-dead sessions are shared:
  // a digest outlives its terminal (that's what makes restore work), and one
  // whose terminal died without a Stop event even stays "active" on disk.
  // `digests` itself stays unfiltered — it is also the crash-restore record.
  const PEER_MAX_AGE_SECS = 8 * 3600;
  const shared = useMemo(
    () =>
      digests.filter(
        (d) => Date.now() / 1000 - (d.updated ?? 0) <= PEER_MAX_AGE_SECS,
      ),
    [digests],
  );

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
  // it's what you kill, and what has a directory. The display *partitions*
  // these rows — agent-hosting terminals under one head, plain shells under
  // another — so each session still appears exactly once.
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
  // Shared with the project's empty state — one definition of "restorable",
  // so the two surfaces can never disagree about what is offered.
  const restorable = useMemo(
    () => restorableFrom(digests, stats, liveSessionIds).map((r) => r.digest),
    [digests, stats, liveSessionIds.join(",")],
  );

  const sessions = useMemo(() => {
    // Terminal -> the agent conversation running in it, by the surface id the
    // hook recorded from our spawn env. An exact identity, not a guess: two
    // claudes in the same directory are indistinguishable by cwd, and matching
    // on titles or newest-file-by-mtime attaches to the wrong one silently.
    // Newest wins if a terminal has hosted more than one session in its life.
    const bySurface = new Map<string, ipc.SessionDigest>();
    for (const d of digests) {
      if (!d.surface) continue;
      const prev = bySurface.get(d.surface);
      if (!prev || (d.updated ?? 0) > (prev.updated ?? 0)) bySurface.set(d.surface, d);
    }
    return stats.map((s) => {
      const agent = s.procs.find(
        (p) => AGENT_PATTERN.test(p.name) || AGENT_PATTERN.test(p.cmd.split(" ")[0] ?? ""),
      );
      return {
        session: s,
        agent,
        digest: bySurface.get(String(s.id)),
        // Where it's running — the thing that tells two `claude` rows apart.
        dir: (s.cwd || "").split("/").filter(Boolean).pop() ?? "",
      };
    });
  }, [stats, digests]);

  // An agent session and a plain shell answer different questions — "what is
  // it working on?" vs "what's running in it?" — so they get separate heads.
  const agentSessions = sessions.filter((x) => x.agent);
  const termSessions = sessions.filter((x) => !x.agent);

  /** Registry id for a process name, so the row can wear the CLI's mark. */
  const agentIdOf = (procName: string) =>
    AGENT_CLIS.find((c) => procName === c.bin || procName.startsWith(c.bin))?.id ?? "agent";

  const sessionRow = ({ session: s, agent, dir, digest }: (typeof sessions)[number]) => {
    const runaway =
      s.total_cpu > settings.runawayCpuPercent ||
      s.total_mem_bytes > settings.runawayMemBytes;
    // What the human last asked for. The highest-signal line about a session:
    // "fix the login redirect" identifies it in a way that cpu, memory and a
    // directory never will.
    const task = lastHumanPrompt(digest?.prompts);
    return (
      <div key={s.id} className={`agent-row ${runaway ? "agent-runaway" : ""}`}>
        <div className="agent-main">
          {/* The CLI's own mark, not its name in bold — the panel is a column
              of near-identical rows and a glyph reads faster than a word. */}
          {agent ? (
            <AgentIcon id={agentIdOf(agent.name)} size={14} className="ap-mark" />
          ) : (
            <TerminalIcon size={13} className="ap-mark" />
          )}
          <span className="agent-name">{agent?.name ?? s.title}</span>
          {dir && (
            <span className="agent-dir" title={s.cwd}>
              {dir}
            </span>
          )}
          {/* Which branch this agent is editing — the difference between
              two identical-looking rows working on different things. */}
          {digest?.branch && (
            <span className="agent-branch" title={`On branch ${digest.branch}`}>
              {digest.branch}
            </span>
          )}
          <span className="agent-session">term #{s.id}</span>
          {/* A dev server in here, without opening the tab to find out. */}
          {s.ports?.map((p) => (
            <span key={p} className="agent-port" title={`Listening on port ${p}`}>
              :{p}
            </span>
          ))}
          {runaway && <span className="runaway-badge">runaway?</span>}
        </div>
        {task && (
          <div className="agent-task" title={task}>
            {task}
          </div>
        )}
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
  };

  // Blocked-on-you vs merely-finished: the same stream, very different urgency.
  const urgent = pending.filter((i) => i.kind !== "idle");
  const idle = pending.filter((i) => i.kind === "idle");

  const dismissBtn = (key: string) =>
    onDismissPending && (
      <button
        className="icon-btn pending-dismiss"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismissPending(key);
        }}
      >
        ✕
      </button>
    );

  return (
    <div className="side-panel">
      {urgent.length > 0 && (
        <>
          <div className="side-panel-head">
            <span>Needs your input</span>
            <span className="badge">{urgent.length}</span>
          </div>
          {urgent.map((item) => (
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
                        {q.options.map((o, oi) => {
                          // Single-select, single-question asks answer from
                          // the panel. Multi-select needs the toggle UI, and
                          // multi-question forms step through questions in the
                          // terminal — a digit there could answer the wrong
                          // one. Those jump instead.
                          const clickable =
                            onAnswer &&
                            !q.multiSelect &&
                            (item.questions?.length ?? 0) === 1;
                          return (
                            <div
                              key={o.label}
                              className={`pending-option ${clickable ? "pending-option-clickable" : ""}`}
                              title={
                                clickable
                                  ? "Answer with this option"
                                  : "Multi-select — answer in the terminal"
                              }
                              onClick={
                                clickable
                                  ? (e) => {
                                      e.stopPropagation();
                                      onAnswer(item, oi);
                                    }
                                  : undefined
                              }
                            >
                              <span className="pending-option-label">
                                {q.multiSelect ? "☐" : "○"} {o.label}
                              </span>
                              {o.description && (
                                <span className="pending-option-desc">{o.description}</span>
                              )}
                            </div>
                          );
                        })}
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
                {dismissBtn(item.key)}
              </div>
            </div>
          ))}
        </>
      )}
      {idle.length > 0 && (
        <>
          <div className="side-panel-head">
            <span>Finished</span>
            <span className="badge">{idle.length}</span>
          </div>
          {idle.map((item) => (
            <div
              key={item.key}
              className="pending-card pending-card-idle"
              onClick={() => onJumpToTerminal?.(item)}
              title="Open the terminal running this agent"
            >
              <div className="pending-q-text">✓ {item.message}</div>
              <div className="pending-footer">
                <span className="event-time">{new Date(item.ts).toLocaleTimeString()}</span>
                <span className="pending-jump">open terminal ➜</span>
                {dismissBtn(item.key)}
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
              {showShared ? "Hide" : "Show"} what's shared ({shared.length})
            </button>
            {showShared &&
              (shared.length === 0 ? (
                <p className="share-none">
                  Nothing yet — a session appears here once it runs a prompt.
                </p>
              ) : (
                shared.map((d) => (
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

      <Section
        title="Running agents"
        count={agentSessions.length}
        action={
          <button
            className="btn-icon"
            title="How to hook up agent CLIs"
            onClick={() => setShowHookHelp((v) => !v)}
          >
            ?
          </button>
        }
      >

      {showHookHelp && hookPath && (
        <div className="hook-help">
          <p>Stream tool-use events from agent CLIs into this panel:</p>
          {/* One button per CLI with an auto-setup arm — every CLI whose
              integration surface supports it (see docs/agent-parity.md).
              setup_agent_hooks in agents.rs is the registry for these. */}
          <div className="hook-setup-row">
            {[
              { id: "claude", label: "Claude Code" },
              { id: "codex", label: "Codex" },
              { id: "agy", label: "Antigravity" },
              { id: "aider", label: "Aider" },
              { id: "opencode", label: "OpenCode" },
              { id: "omp", label: "oh-my-pi" },
              { id: "amp", label: "Amp" },
            ].map((a) => (
              <button
                key={a.id}
                className="btn btn-accent"
                onClick={() => void autoSetup(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
          {setupResult && <p className="hook-result">{setupResult}</p>}
          <p>
            Other CLIs: point any hook at appending single-line JSON to:
          </p>
          <code className="hook-path">{hookPath}</code>
        </div>
      )}

      {agentSessions.length === 0 ? (
        <div className="tree-empty">
          No agents running. Launch <code>claude</code>, <code>codex</code>, etc. from the ＋
          menu or by right-clicking a component.
        </div>
      ) : (
        agentSessions.map(sessionRow)
      )}
      </Section>

      {termSessions.length > 0 && (
        <Section title="Terminals" count={termSessions.length}>
          {termSessions.map(sessionRow)}
        </Section>
      )}

      {restorable.length > 0 && (
        <Section title="Restorable sessions" count={restorable.length} tone="quiet">
          <div className="restore-help">
            Not open right now — reopening runs the agent's own resume, so it
            comes back with its history.
          </div>
          {restorable.map((d) => {
            const agentId = d.agent ?? "agent";
            // resume_cwd, not cwd: claude looks the conversation up under its
            // project root, so resuming from the subdirectory the agent ran in
            // reports "No conversation found".
            const runIn = d.resume_cwd || d.cwd || "";
            const cmd = d.resumable === false ? null : restoreCommand(agentId, d.session_id);
            const dir = runIn.split("/").filter(Boolean).pop() ?? "";
            const last = lastHumanPrompt(d.prompts);
            return (
              <div key={d.session_id} className="restore-row">
                <div className="restore-main">
                  <AgentIcon id={agentId} size={14} className="ap-mark" />
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
                    a bare uuid tells you nothing. Non-claude agents may not
                    have one captured; say so instead of rendering nothing. */}
                <div className="restore-prompt">
                  {last ?? <em>(no prompt captured for this session)</em>}
                </div>
                {/* Two icon actions in the row's own top-right corner: the
                    empty column beside the text was doing nothing, and two
                    full-width buttons per row made four sessions look like a
                    form. Labels come back on hover. */}
                <div className="restore-actions">
                  {cmd ? (
                    <button
                      className="row-act row-act-go"
                      title={`Restore this session — ${cmd}`}
                      onClick={() => onRestore?.(runIn, cmd, agentId, agentId)}
                    >
                      <RestartIcon size={13} />
                      <span className="row-act-label">Restore</span>
                    </button>
                  ) : (
                    // The agent wrote no transcript (or its CLI can't reopen
                    // by id), so every --resume against this fails. Say so
                    // rather than offer a button whose only outcome is a red
                    // error in a terminal.
                    <span
                      className="restore-unsupported"
                      title={
                        d.resumable === false
                          ? "No saved history for this session"
                          : `${agentId} cannot reopen a specific past session by id`
                      }
                    >
                      can't resume
                    </span>
                  )}
                  <button
                    className="row-act row-act-del"
                    title="Forget this session — removes it from this list"
                    onClick={() => {
                      void ipc.sessionForget(d.session_id).then(() =>
                        setDigests((prev) => prev.filter((x) => x.session_id !== d.session_id)),
                      );
                    }}
                  >
                    <TrashIcon size={13} />
                    <span className="row-act-label">Forget</span>
                  </button>
                </div>
              </div>
            );
          })}
        </Section>
      )}
    </div>
  );
}

// Agent management: one row per terminal session, named after the agent CLI
// detected inside its process tree, with CPU/memory for the runaway guard.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { AGENT_CLIS, AGENT_PATTERN, restoreCommand } from "../projects";
import { forgetSessions, restorableFrom } from "../restorable";
import { AgentIcon, MoonIcon, RestartIcon, TerminalIcon, TrashIcon } from "./icons";
import type { PendingItem } from "../notifications";

/** Colour + label for the lifecycle dot on a running-agent row. `working` is
 *  the only state that pulses — a moving dot in a column of still ones is
 *  where the eye lands first. */
export const STATE_META: Record<string, { cls: string; label: string }> = {
  working: { cls: "st-working", label: "working" },
  waiting: { cls: "st-waiting", label: "waiting on you" },
  idle: { cls: "st-idle", label: "idle — finished a turn" },
  ended: { cls: "st-ended", label: "session ended" },
};

/** CLIs whose approval prompt is a numbered/Escape menu we can drive by
 *  synthesising keystrokes. Anything else gets "answer in terminal" instead of
 *  buttons that might type into the wrong UI. */
const KEYSTROKE_APPROVAL_AGENTS = new Set(["claude", "codex"]);

interface AgentsPanelProps {
  stats: ipc.SessionStats[];
  hookPath: string | null;
  pending?: PendingItem[];
  onDismissPending?: (key: string) => void;
  /** Answer a questionnaire from the panel. `selections[q]` is the option
   *  index(es) chosen for question q — one for single-select, zero-or-more for
   *  multi-select. The backend synthesises the keystrokes to fill the (possibly
   *  multi-step) terminal form. */
  onAnswer?: (item: PendingItem, selections: number[][]) => void;
  /** Respond to a permission prompt without leaving the panel: approve types
   *  the accept key into the agent's terminal, deny sends Escape. Only offered
   *  for numbered-prompt CLIs (claude/codex). */
  onRespond?: (item: PendingItem, decision: "approve" | "deny") => void;
  onJumpToTerminal?: (item: PendingItem) => void;
  /** Focus the tab a running session is in. Separate from onJumpToTerminal:
   *  that one guesses a tab from a notification's cwd, this one has the pty
   *  id in hand and is exact. */
  onJumpToPty?: (ptyId: number) => void;
  /** Open an agent's workspace tab: its files, diffs, commits and PR. Rows
   *  with a digest go here; the `term #n` chip still jumps to the terminal. */
  onOpenAgent?: (digest: ipc.SessionDigest, ptyId: number) => void;
  /** The pty of the terminal tab currently in front, so its row can be
   *  highlighted — the reverse of onJumpToPty: relate the tab you're on back to
   *  its row in the list. Null when the active tab isn't a terminal. */
  activePty?: number | null;
  /** Cross-session context sharing for this project. */
  roots: string[];
  shareContext: boolean;
  onShareContext: (on: boolean) => void;
  /** Session ids currently attached to a live terminal in this app run. */
  liveSessionIds?: string[];
  /** Reopen a past agent session: runs `cmd` in `cwd` as a new terminal. */
  onRestore?: (cwd: string, cmd: string, title: string, agentId: string) => void;
  /** Toasts for background actions (auto-hibernation) the user didn't click. */
  onNotice?: (msg: string) => void;
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
export const lastHumanPrompt = (prompts?: string[]) =>
  [...(prompts ?? [])]
    .reverse()
    .find((p) => p.trim().length > 0 && !p.trimStart().startsWith("<"));

/** Pair each terminal (by the PTY `surface` id the hook recorded from our spawn
 *  env) with the newest digest tagged for this app launch — an exact identity,
 *  not a cwd/title guess. Shared with ProjectView so the Agents panel and the
 *  workspace drawer resolve the same session for a given terminal. */
export function digestBySurface(
  digests: ipc.SessionDigest[],
  thisInstance: string | null,
): Map<string, ipc.SessionDigest> {
  const bySurface = new Map<string, ipc.SessionDigest>();
  for (const d of digests) {
    if (!d.surface) continue;
    // A PTY id is only unique within one app launch, but the sessions dir is
    // shared across instances and restarts — so a digest tagged with another
    // `instance` reused this id and must be skipped. Untagged digests are
    // pre-upgrade and fall back to surface-only.
    if (thisInstance && d.instance && d.instance !== thisInstance) continue;
    const prev = bySurface.get(d.surface);
    if (!prev || (d.updated ?? 0) > (prev.updated ?? 0)) bySurface.set(d.surface, d);
  }
  return bySurface;
}

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
  onJumpToPty,
  onOpenAgent,
  activePty,
  roots,
  shareContext,
  onShareContext,
  liveSessionIds = [],
  onRestore,
  onRespond,
  onNotice,
}: AgentsPanelProps) {
  const [showHookHelp, setShowHookHelp] = useState(false);
  const [setupResult, setSetupResult] = useState<string | null>(null);
  // null while we haven't checked yet — the nudge stays hidden until we know,
  // so it never flashes the wrong message. See the effect keyed on noHookSignal.
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  // Dismissing the "restart to stream" hint sticks across panels and launches:
  // once you know the agents just predate the hooks, you don't need telling in
  // every project. The genuine "not set up" nudge ignores this and always shows.
  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem("canopy.hookHintDismissed") === "1",
  );
  const dismissHint = () => {
    localStorage.setItem("canopy.hookHintDismissed", "1");
    setHintDismissed(true);
  };
  // Per-card selections for multi-step questionnaires, keyed by item.key;
  // picks[key][questionIndex] is the option index(es) chosen for that question.
  // A lone single-select question answers on the click and never lands here.
  const [picks, setPicks] = useState<Record<string, number[][]>>({});
  const emptyPicks = (item: PendingItem) =>
    (item.questions ?? []).map(() => [] as number[]);
  const picksFor = (item: PendingItem) => picks[item.key] ?? emptyPicks(item);
  const choose = (item: PendingItem, qi: number, oi: number, multi: boolean) => {
    setPicks((prev) => {
      const cur = (prev[item.key] ?? emptyPicks(item)).map((a) => [...a]);
      cur[qi] = multi
        ? cur[qi].includes(oi)
          ? cur[qi].filter((x) => x !== oi)
          : [...cur[qi], oi]
        : [oi];
      return { ...prev, [item.key]: cur };
    });
  };
  const answerable = (item: PendingItem) =>
    (item.questions ?? []).every((_, qi) => (picksFor(item)[qi]?.length ?? 0) > 0);
  const submitAnswers = (item: PendingItem) => {
    onAnswer?.(item, picksFor(item));
    setPicks(({ [item.key]: _drop, ...rest }) => rest);
  };
  // A single single-select question answers on the option click itself; a
  // multi-select or multi-question form collects picks and submits together.
  const instantAnswer = (item: PendingItem) =>
    (item.questions?.length ?? 0) === 1 && !item.questions?.[0]?.multiSelect;
  const [digests, setDigests] = useState<ipc.SessionDigest[]>([]);
  // This app launch's tag, so a digest from another instance/run (same reset-to-1
  // PTY id, same shared sessions dir) can't be paired with our terminals.
  const [thisInstance, setThisInstance] = useState<string | null>(null);
  useEffect(() => {
    void ipc.instanceId().then(setThisInstance).catch(() => {});
  }, []);
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
    const bySurface = digestBySurface(digests, thisInstance);
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
  }, [stats, digests, thisInstance]);

  // An agent session and a plain shell answer different questions — "what is
  // it working on?" vs "what's running in it?" — so they get separate heads.
  const agentSessions = sessions.filter((x) => x.agent);
  const termSessions = sessions.filter((x) => !x.agent);

  // Agents are running but not one of them has a digest — nothing is streaming
  // from their hooks, which is exactly why a question or task never appears in
  // this panel. A single digest anywhere proves hooks work, so this only fires
  // when they're genuinely not wired up. Nudge the one-click setup rather than
  // leave the panel silently blind.
  const noHookSignal =
    agentSessions.length > 0 && agentSessions.every((x) => !x.digest);

  // No digest could mean hooks aren't installed OR that these agents were
  // started before they were — opposite fixes. Ask the backend which it is, so
  // the panel offers "set up" only when they're genuinely missing and otherwise
  // says "restart to stream". Re-checked whenever the silence appears (e.g.
  // right after a one-click setup), never polled.
  useEffect(() => {
    if (!noHookSignal) {
      setHooksInstalled(null);
      return;
    }
    void ipc.agentHooksInstalled("claude").then(setHooksInstalled).catch(() => {});
  }, [noHookSignal, setupResult]);

  // Hibernate an agent: kill its terminal to reclaim the memory, keeping the
  // session digest (which is already the restore record) so the row reappears
  // under "Restorable" and its own --resume brings it back with history.
  const hibernate = (id: number) => void ipc.ptyKill(id);

  // Auto-hibernation. Reclaim the stalest *finished* agents once a project is
  // over its cap — never one mid-turn or blocked on the user, and never twice
  // (a killed pty lingers in `stats` until the next poll, and pty ids are
  // monotonic within a run, so a set of ids we've already reclaimed is enough
  // to keep the toast from repeating and ptyKill from firing on the dead).
  const hibernatedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!settings.autoHibernate) return;
    const cap = Math.max(1, settings.maxLiveAgents);
    const live = agentSessions.filter((x) => !hibernatedRef.current.has(x.session.id));
    if (live.length <= cap) return;
    const reclaimable = live
      .filter((x) => x.digest?.state === "idle" || x.digest?.state === "ended")
      .sort((a, b) => (a.digest?.updated ?? 0) - (b.digest?.updated ?? 0));
    const victims = reclaimable.slice(0, live.length - cap);
    for (const v of victims) {
      hibernatedRef.current.add(v.session.id);
      hibernate(v.session.id);
    }
    if (victims.length > 0) {
      onNotice?.(
        `Hibernated ${victims.length} idle agent${
          victims.length > 1 ? "s" : ""
        } to free memory — resume from Restorable.`,
      );
    }
  }, [agentSessions, settings.autoHibernate, settings.maxLiveAgents, onNotice]);

  /** Registry id for a process name, so the row can wear the CLI's mark. */
  const agentIdOf = (procName: string) =>
    AGENT_CLIS.find((c) => procName === c.bin || procName.startsWith(c.bin))?.id ?? "agent";

  const sessionRow = ({ session: s, agent, dir, digest }: (typeof sessions)[number]) => {
    const runaway =
      s.total_cpu > settings.runawayCpuPercent ||
      s.total_mem_bytes > settings.runawayMemBytes;
    // Lifecycle dot: only for agent rows the hook stream has spoken for.
    const st = agent && digest?.state ? STATE_META[digest.state] : undefined;
    // Only reclaim an agent that has finished — never one mid-turn or blocked.
    const canHibernate =
      !!agent && (digest?.state === "idle" || digest?.state === "ended");
    // What the human last asked for. The highest-signal line about a session:
    // "fix the login redirect" identifies it in a way that cpu, memory and a
    // directory never will.
    const task = lastHumanPrompt(digest?.prompts);
    return (
      <div
        key={s.id}
        className={`agent-row ${runaway ? "agent-runaway" : ""} ${
          onJumpToPty ? "agent-row-jump" : ""
        } ${s.id === activePty ? "agent-row-active" : ""}`}
        // A row with a digest opens the agent's workspace — its files, diffs,
        // commits and PR; the `term #n` chip remains the way to the terminal.
        // Rows the hook stream hasn't spoken for (plain terminals) keep the
        // old behavior: the terminal is all there is to show.
        onClick={() =>
          digest && onOpenAgent ? onOpenAgent(digest, s.id) : onJumpToPty?.(s.id)
        }
        // Rows truncate to one line each now; the full detail lives here.
        title={[
          agent?.name ?? s.title,
          s.cwd,
          digest?.branch,
          task,
          digest && onOpenAgent ? "Click to open this agent's workspace" : undefined,
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <div className="agent-main">
          {/* Lifecycle at a glance: green pulse = working, amber = waiting on
              you, grey = idle, faded = ended. */}
          {st && <span className={`agent-state-dot ${st.cls}`} title={st.label} />}
          {/* The CLI's own mark, not its name in bold — the panel is a column
              of near-identical rows and a glyph reads faster than a word. */}
          {agent ? (
            <AgentIcon id={agentIdOf(agent.name)} size={14} className="ap-mark" />
          ) : (
            <TerminalIcon size={13} className="ap-mark" />
          )}
          <span className="agent-name">{agent?.name ?? s.title}</span>
          {/* Kept on the left, right after the name: the hover stats overlay is
              anchored to the row's right edge, so a badge over there gets buried
              the moment you hover the very row you're trying to inspect. */}
          {runaway && <span className="runaway-badge">runaway?</span>}
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
          {/* Blocked on you, stated on the row itself so it survives whether
              or not the transient card is up and whichever tab is focused —
              the durable "needs input" signal, not a fleeting event. */}
          {digest?.state === "waiting" && (
            <span className="agent-needs-you" title="This agent is waiting for your answer">
              needs you
            </span>
          )}
          {/* Helpers this turn spawned, so a quiet-looking row that's actually
              fanning out work reads as busy rather than idle. */}
          {(digest?.subagents ?? 0) > 0 && (
            <span
              className="agent-subagents"
              title={`${digest?.subagents} subagent${digest?.subagents === 1 ? "" : "s"} finished this turn`}
            >
              ⑃ {digest?.subagents}
            </span>
          )}
          <button
            className="agent-session"
            title={`Go to terminal #${s.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onJumpToPty?.(s.id);
            }}
          >
            term #{s.id}
          </button>
          {/* A dev server in here, without opening the tab to find out. */}
          {s.ports?.map((p) => (
            <button
              key={p}
              className="agent-port"
              title={`Open http://localhost:${p} in your browser`}
              onClick={(e) => {
                e.stopPropagation();
                void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                  openUrl(`http://localhost:${p}`),
                );
              }}
            >
              :{p}
            </button>
          ))}
        </div>
        {task && <div className="agent-task">{task}</div>}
        <div className="agent-stats">
          <span>{s.total_cpu.toFixed(0)}% cpu</span>
          <span>{fmtMem(s.total_mem_bytes)}</span>
          <span>{s.procs.length} procs</span>
          {canHibernate && (
            <button
              className="btn-icon"
              title="Hibernate — frees memory now; resume later from Restorable with its history"
              onClick={(e) => {
                e.stopPropagation();
                hibernate(s.id);
              }}
            >
              <MoonIcon size={12} />
            </button>
          )}
          <button
            className="btn-icon btn-danger"
            title={`Kill terminal #${s.id}${agent ? ` and the ${agent.name} running in it` : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              void ipc.ptyKill(s.id);
            }}
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
                  {(item.questions ?? []).map((q, i) => {
                    const sel = picksFor(item)[i] ?? [];
                    return (
                      <div key={i} className="pending-question">
                        {q.header && <span className="pending-chip">{q.header}</span>}
                        <div className="pending-q-text">{q.question}</div>
                        <div className="pending-options">
                          {q.options.map((o, oi) => {
                            // Every option is now selectable in the panel. A
                            // lone single-select answers on the click; anything
                            // multi-step (multi-select, or several questions)
                            // records the pick here and submits via the button
                            // below. The synthesised keystrokes fill the
                            // terminal form; it stays reachable as the fallback.
                            const chosen = sel.includes(oi);
                            const mark = q.multiSelect
                              ? chosen
                                ? "☑"
                                : "☐"
                              : chosen
                                ? "◉"
                                : "○";
                            return (
                              <div
                                key={o.label}
                                className={`pending-option ${onAnswer ? "pending-option-clickable" : ""} ${
                                  chosen ? "pending-option-chosen" : ""
                                }`}
                                title={onAnswer ? "Select this option" : "Answer in the terminal"}
                                onClick={
                                  onAnswer
                                    ? (e) => {
                                        e.stopPropagation();
                                        if (instantAnswer(item)) onAnswer(item, [[oi]]);
                                        else choose(item, i, oi, !!q.multiSelect);
                                      }
                                    : undefined
                                }
                              >
                                <span className="pending-option-label">
                                  {mark} {o.label}
                                </span>
                                {o.description && (
                                  <span className="pending-option-desc">{o.description}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {/* Multi-step forms submit all picks as one keystroke
                      sequence. A lone single-select answered on click above, so
                      it shows no button. */}
                  {onAnswer && !instantAnswer(item) && (
                    <button
                      className="btn btn-accent pending-submit"
                      disabled={!answerable(item)}
                      title={
                        answerable(item)
                          ? "Send these answers to the terminal"
                          : "Choose an option for every question first"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        submitAnswers(item);
                      }}
                    >
                      {(item.questions?.length ?? 0) > 1 ? "Submit answers" : "Submit answer"}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="pending-q-text">🔔 {item.message}</div>
                  {/* Respond without leaving the panel: Allow types the accept
                      key, Deny sends Escape. Only for CLIs whose prompt we can
                      drive by keystroke — the rest fall back to the terminal. */}
                  {onRespond && KEYSTROKE_APPROVAL_AGENTS.has(item.agent) && (
                    <div className="pending-respond">
                      <button
                        className="pending-approve"
                        title="Allow — types the accept key into the terminal"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRespond(item, "approve");
                        }}
                      >
                        ✓ Allow
                      </button>
                      <button
                        className="pending-deny"
                        title="Deny — sends Escape to the terminal"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRespond(item, "deny");
                        }}
                      >
                        ✕ Deny
                      </button>
                    </div>
                  )}
                </>
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

      {/* Hooks genuinely absent — offer the one-click setup. */}
      {noHookSignal && !showHookHelp && hooksInstalled === false && (
        <div className="hook-nudge">
          <span>
            Agents are running, but no events are streaming in — questions,
            tasks and tokens won't show until hooks are set up.
          </span>
          <button className="btn btn-accent" onClick={() => void autoSetup("claude")}>
            Set up Claude Code hooks
          </button>
          {setupResult && <p className="hook-result">{setupResult}</p>}
        </div>
      )}

      {/* Hooks are installed; these agents just predate them. Say the thing that
          actually fixes it (restart) instead of the setup button, and let it be
          dismissed — otherwise it nags in every project forever. */}
      {noHookSignal && !showHookHelp && hooksInstalled === true && !hintDismissed && (
        <div className="hook-nudge">
          <span>
            Hooks are set up, but these agents started before that — restart one
            to stream its questions, tasks and tokens here.
          </span>
          <button className="btn" onClick={dismissHint}>
            Got it
          </button>
        </div>
      )}

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
                      // Tombstone first: sessions read from a CLI's own on-disk
                      // store (omp) aren't in ~/.canopy/sessions, so deleting
                      // that file can't stop them — the next poll re-reads them
                      // from omp's dir and they come straight back. The
                      // persistent forget is what restorableFrom actually
                      // filters on, so it's the only thing that makes an omp
                      // session stay gone.
                      forgetSessions([d]);
                      void ipc.sessionForget(d.session_id).catch(() => {});
                      setDigests((prev) => prev.filter((x) => x.session_id !== d.session_id));
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

// Bottom status tray: git branch, running agent, model, tokens, estimated
// cost. Token/model data comes from Claude Code session transcripts (path
// arrives via hook events); cost is an estimate from a static pricing map.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { fmtTokens } from "../format";
import * as ipc from "../ipc";
import { estimateCost, sessionCost } from "../pricing";
import { chipText, planFor, planTone, tooltip } from "../planUsage";
import { StatsPanel } from "./StatsPanel";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { HeartIcon, StatsIcon } from "./icons";
import type { AgentEventEntry } from "../types";
import { modelCommandLine, type ModelSwitch } from "../agentModels";
import { useBranchSwitch } from "../useBranchSwitch";

/** How many branches the tray's menu offers. It is a shortcut to the handful
 *  you are actually moving between — `for-each-ref` hands them back newest
 *  first, so this is "the ones you touched recently", not an arbitrary slice. */
const BRANCH_MENU_LIMIT = 12;

const fmtMem = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

/** Last stats seen per transcript, module-wide — switching tabs (or
 *  projects) shows the right model/tokens instantly from cache while the
 *  fresh poll runs, instead of carrying the previous tab's numbers. */
const TRANSCRIPT_STATS = new Map<string, ipc.ClaudeSessionStats>();


interface StatusBarProps {
  roots: string[];
  agents: { name: string; cpu: number }[];
  events: AgentEventEntry[];
  /** This project is the one on screen. Hidden projects freeze their polling
   *  (git status, transcript stats) instead of burning it in the background. */
  visible: boolean;
  /** All open projects — the resource popup groups every session by project. */
  projects: { name: string; roots: string[] }[];
  /** Switches the model of the session the tray is showing. `model` is the id
   *  of one of `modelSwitch`'s choices, and is omitted for a picker — that
   *  command carries no argument. */
  onSetModel?: (model?: string) => void;
  /** How the CLI in front changes model, or null when Canopy has no verified
   *  way to change that one's (see agentModels.ts) — then no control is shown,
   *  rather than a menu that types a command the CLI doesn't have. */
  modelSwitch?: ModelSwitch | null;
  /** What to call the CLI in front in the switch dialog ("Codex CLI"). */
  agentLabel?: string;
  /** Registry id of the CLI in front ("claude", "codex"), used to pick which
   *  plan's headroom the chip shows. Separate from agentLabel because that one
   *  is absent for CLIs Canopy can't switch models on. */
  agentId?: string | null;
  /** The pty of the active terminal tab — the model/token tray follows THIS
   *  tab's session, not whichever session in the project spoke last. */
  activePtyId?: number | null;
}

export const StatusBar = memo(function StatusBar({
  roots,
  agents,
  events,
  visible,
  projects,
  onSetModel,
  modelSwitch,
  agentLabel,
  agentId,
  activePtyId,
}: StatusBarProps) {
  const [branch, setBranch] = useState<string | null>(null);
  const [dirty, setDirty] = useState(0);
  const [branches, setBranches] = useState<ipc.BranchInfo[]>([]);
  const { switchTo, version } = useBranchSwitch();
  const branchMenu = useContextMenu();
  const [app, setApp] = useState<ipc.AppStats | null>(null);
  const [stats, setStats] = useState<ipc.ClaudeSessionStats | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  // The pending switch, held for confirmation. `id` is absent for a picker:
  // there is no model to name yet, the command only opens the CLI's chooser.
  const [confirmModel, setConfirmModel] = useState<{
    id?: string;
    label: string;
  } | null>(null);
  // Resource breakdown popup. Machine-wide session stats are subscribed only
  // while it is open — the rest of the time this component costs nothing.
  const [breakdown, setBreakdown] = useState(false);
  const [allSessions, setAllSessions] = useState<ipc.SessionStats[]>([]);
  // All-CLI usage & cost popup, anchored to the stats chip in the corner.
  const [statsOpen, setStatsOpen] = useState(false);
  const statsAnchorRef = useRef<HTMLSpanElement>(null);
  // Native dismissal: click anywhere outside, or Escape. Mouse-leave felt
  // flimsy on a panel this size — the cursor grazes the edge and it vanishes.
  useEffect(() => {
    if (!statsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!statsAnchorRef.current?.contains(e.target as Node))
        setStatsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStatsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [statsOpen]);
  // Popups anchored to a chip must escape .status-bar's overflow:hidden (it
  // clips its one-line row — and clipped everything that pops above it, so
  // only a shadow sliver ever showed). Fixed positioning, measured from the
  // clicked chip, ignores ancestor clipping entirely.
  const [menuPos, setMenuPos] = useState<{
    right: number;
    bottom: number;
  } | null>(null);
  const anchorMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({
      right: Math.max(8, window.innerWidth - r.right),
      bottom: window.innerHeight - r.top + 6,
    });
  };
  const menuStyle = menuPos
    ? ({
        position: "fixed",
        right: menuPos.right,
        bottom: menuPos.bottom,
      } as const)
    : undefined;
  const [openSessions, setOpenSessions] = useState<Record<number, boolean>>({});
  // All-CLI token/cost usage, for the grand-total row atop the popup. Fetched
  // (not streamed) only while the popup is open — it costs nothing otherwise.
  const [usage, setUsage] = useState<ipc.AgentSessionUsage[]>([]);
  useEffect(() => {
    if (!breakdown) return;
    const sub = ipc.onPtyStats(setAllSessions);
    let cancelled = false;
    const pull = () =>
      void ipc
        .agentUsage()
        .then((u) => {
          if (!cancelled) setUsage(u);
        })
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setAllSessions([]);
      setUsage([]);
      void sub.then((fn) => fn());
    };
  }, [breakdown]);

  // Whole-app footprint, pushed from the Rust monitor. Only the visible
  // project listens — every hidden StatusBar re-rendering on each tick is
  // work nobody can see.
  useEffect(() => {
    if (!visible) return;
    const sub = ipc.onAppStats(setApp);
    return () => void sub.then((fn) => fn());
  }, [visible]);

  // Subscription headroom. Visible-gated like everything else here, and slow:
  // these are rolling windows measured in hours, so a minute of lag is
  // invisible while a tighter poll would re-scan Codex's rollout files for
  // nothing.
  const [plans, setPlans] = useState<ipc.PlanUsage[]>([]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const pull = () =>
      void ipc
        .planUsage()
        .then((p) => {
          if (!cancelled) setPlans(p);
        })
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible]);
  const plan = useMemo(() => planFor(plans, agentId), [plans, agentId]);

  // The transcript whose model/tokens the tray shows. Per-TAB first: prefer
  // the latest event stamped with the active terminal's pty, so switching
  // tabs switches the tray immediately instead of showing whichever session
  // in the project spoke last (which only corrected itself when the newly
  // focused agent next emitted an event). Project-latest is the fallback for
  // non-terminal tabs and unstamped events.
  //
  // A terminal whose pty appears in no stamped event shows NOTHING rather than
  // project-latest. That fallback was written for tabs that have no session of
  // their own, but it also fired on a tab running a CLI whose transcript we
  // can't read (Codex, opencode) — so the tray sat over a Codex session
  // reporting a Claude model and Claude's tokens. Only when nothing in the
  // stream carries a pty at all (an older hook that can't stamp them) does the
  // project-wide guess stay the best available answer.
  const transcript = useMemo(() => {
    let projectLatest: string | null = null;
    let anyStamped = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const d = events[i].data;
      if (
        !d?.transcriptPath ||
        !d.cwd ||
        !roots.some((r) => d.cwd === r || d.cwd.startsWith(r + "/"))
      ) {
        continue;
      }
      if (activePtyId != null && d.pty === activePtyId) return d.transcriptPath;
      if (d.pty != null) anyStamped = true;
      projectLatest ??= d.transcriptPath;
    }
    return activePtyId != null && anyStamped ? null : projectLatest;
  }, [events, roots, activePtyId]);

  // Both pollers gate on `visible`: each spawns a git subprocess / transcript
  // read per tick per project, and a backgrounded project doesn't need either.
  // Switching back re-runs the effect, which refreshes immediately.
  useEffect(() => {
    if (!roots[0] || !visible) return;
    let cancelled = false;
    const refresh = () => {
      void ipc
        .gitStatus(roots[0])
        .then((s) => {
          if (cancelled) return;
          setBranch(s.branch);
          setDirty(s.entries.filter((e) => e.status !== "!!").length);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `version` bumps whenever the funnel moves a ref, so the chip catches up
    // with a switch immediately instead of at the next ten-second tick.
  }, [roots[0], visible, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // The branch list behind the chip's menu. Deliberately NOT on the status
  // poll's timer: one `for-each-ref` when the project appears and again after
  // anything moves a ref is enough, and a third git process every ten seconds
  // per project is exactly the cost this component is careful about.
  useEffect(() => {
    if (!roots[0] || !visible) return;
    let cancelled = false;
    void ipc
      .gitBranches(roots[0])
      .then((b) => !cancelled && setBranches(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roots[0], visible, version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Cached value first (or nothing if this session was never seen) — the
    // tray must never show another tab's model while the poll is in flight.
    setStats(transcript ? (TRANSCRIPT_STATS.get(transcript) ?? null) : null);
    if (!transcript || !visible) return;
    let cancelled = false;
    const refresh = () => {
      void ipc
        .claudeSessionStats(transcript)
        .then((s) => {
          TRANSCRIPT_STATS.set(transcript, s);
          if (!cancelled) setStats(s);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transcript, visible]);

  const cost = stats ? estimateCost(stats) : null;

  // `rev-parse --abbrev-ref HEAD` answers a literal "HEAD" off a branch, which
  // the tray used to print as if it were one. It is the snapshot state the Git
  // panel already names, and the one place a person most needs the way back.
  const detached = branch === "HEAD";
  const files = `${dirty} changed ${dirty === 1 ? "file" : "files"}`;

  /** The chip's menu: somewhere to go, always. Every row is a switch through
   *  the one funnel, so a branch held by another workspace asks its question
   *  here exactly as it does in the Git panel. */
  const branchItems = (): MenuItem[] => {
    const repo = roots[0];
    const items: MenuItem[] = [];
    if (detached)
      items.push({
        separator: true,
        label:
          "You're looking at a snapshot. Pick a branch to go back — nothing you had is lost.",
      });
    const rest = branches.filter((b) => !b.current);
    if (!repo || rest.length === 0) {
      items.push({ label: "Nowhere else to go yet", disabled: true });
      return items;
    }
    for (const b of rest.slice(0, BRANCH_MENU_LIMIT))
      items.push({
        label: b.name,
        hint: b.remote_only ? "on the remote" : undefined,
        onClick: () => void switchTo(repo, { kind: "branch", branch: b.name }),
      });
    if (rest.length > BRANCH_MENU_LIMIT)
      items.push({
        label: `${rest.length - BRANCH_MENU_LIMIT} more in the Git panel`,
        disabled: true,
      });
    return items;
  };

  return (
    <div className="status-bar">
      {branch && (
        <span className="status-item status-branch">
          <button
            className="status-model-btn"
            title={
              detached
                ? `You're looking at a snapshot of the code · ${files}. Click to go back.`
                : `On ${branch} · ${files}. Click to switch.`
            }
            // The tray sits on the bottom edge, so the menu grows upward from
            // the chip rather than off the end of the window.
            onClick={(e) => branchMenu.openAbove(e, branchItems())}
          >
            {detached ? "⚠ snapshot" : `⎇ ${branch}`}
            {dirty > 0 && <span className="status-dirty"> ±{dirty}</span>}
          </button>
        </span>
      )}
      {agents.length > 0 && (
        <span className="status-item status-agent" title="running agents">
          <span className="status-agent-dot" aria-hidden />
          {agents.map((a) => a.name).join(", ")}
        </span>
      )}
      <span className="status-spacer" />
      {app && (
        <span className="status-item status-res status-model-anchor">
          <button
            className="status-model-btn"
            title={
              `canopy: ${app.procs} process${app.procs === 1 ? "" : "es"} — ` +
              `Rust core, language servers, terminals and everything they spawned. ` +
              `Click for the per-project breakdown.\n\n` +
              `Does not include the WebView: macOS runs it in system-owned WebKit ` +
              `processes parented to launchd, which can't be attributed back to us.`
            }
            onClick={(e) => {
              anchorMenu(e);
              setBreakdown((v) => !v);
            }}
          >
            {app.cpu.toFixed(0)}% cpu · {fmtMem(app.mem_bytes)}
          </button>
          {breakdown && (
            <div
              className="status-menu status-breakdown"
              style={menuStyle}
              onMouseLeave={() => setBreakdown(false)}
            >
              {(() => {
                // Each session lands in the first project whose roots contain
                // its cwd; two projects sharing a root can't double-count it.
                const assigned = new Set<number>();
                const groups = projects
                  .map((p) => {
                    const mine = allSessions.filter(
                      (s) =>
                        !assigned.has(s.id) &&
                        p.roots.some(
                          (r) => s.cwd === r || s.cwd.startsWith(r + "/"),
                        ),
                    );
                    mine.forEach((s) => assigned.add(s.id));
                    return { name: p.name, sessions: mine };
                  })
                  .filter((g) => g.sessions.length > 0);
                const other = allSessions.filter((s) => !assigned.has(s.id));
                if (other.length > 0)
                  groups.push({ name: "Other terminals", sessions: other });
                const termCpu = allSessions.reduce(
                  (n, s) => n + s.total_cpu,
                  0,
                );
                const termMem = allSessions.reduce(
                  (n, s) => n + s.total_mem_bytes,
                  0,
                );
                const usSent = usage.reduce(
                  (n, u) =>
                    n +
                    u.input_tokens +
                    u.cache_read_tokens +
                    u.cache_creation_tokens,
                  0,
                );
                const usRecv = usage.reduce((n, u) => n + u.output_tokens, 0);
                let usCost = 0;
                let usEst = false;
                let usPriced = false;
                for (const u of usage) {
                  const c = sessionCost(u);
                  if (c != null) {
                    usCost += c;
                    usPriced = true;
                    if (u.cost == null) usEst = true;
                  }
                }
                return (
                  <>
                    {/* The cpu/mem chip this popped from already shows the
                        resource total, but not tokens/cost — so lead with an
                        all-CLI usage total, then the per-project resource tree. */}
                    {usage.length > 0 && (
                      <div
                        className="bd-head bd-usage"
                        title="Tokens sent/received and estimated cost across every session Canopy tracks (all CLIs)"
                      >
                        <span>Tokens · cost · all CLIs</span>
                        <span className="bd-nums">
                          ↑{fmtTokens(usSent)} ↓{fmtTokens(usRecv)}
                          {usPriced &&
                            ` · ${usEst ? "~" : ""}$${usCost.toFixed(2)}`}
                        </span>
                      </div>
                    )}
                    {groups.map((g) => {
                      const cpu = g.sessions.reduce(
                        (n, s) => n + s.total_cpu,
                        0,
                      );
                      const mem = g.sessions.reduce(
                        (n, s) => n + s.total_mem_bytes,
                        0,
                      );
                      return (
                        <div key={g.name} className="bd-group">
                          <div className="bd-head">
                            <span>{g.name}</span>
                            <span className="bd-nums">
                              {cpu.toFixed(0)}% · {fmtMem(mem)}
                            </span>
                          </div>
                          {g.sessions.map((s) => {
                            const sOpen = openSessions[s.id] ?? false;
                            return (
                              <div key={s.id}>
                                <div
                                  className="bd-row bd-session"
                                  title={s.cwd}
                                  onClick={() =>
                                    setOpenSessions((prev) => ({
                                      ...prev,
                                      [s.id]: !sOpen,
                                    }))
                                  }
                                >
                                  <span>
                                    <span className="tree-chevron">
                                      {sOpen ? "▾" : "▸"}
                                    </span>
                                    {s.title || "shell"}
                                    {s.ports.length > 0 && (
                                      <span className="bd-ports">
                                        {" "}
                                        :{s.ports.join(" :")}
                                      </span>
                                    )}
                                  </span>
                                  <span className="bd-nums">
                                    {s.total_cpu.toFixed(0)}% ·{" "}
                                    {fmtMem(s.total_mem_bytes)}
                                  </span>
                                </div>
                                {sOpen &&
                                  [...s.procs]
                                    .sort((a, b) => b.mem_bytes - a.mem_bytes)
                                    .slice(0, 8)
                                    .map((p) => (
                                      <div
                                        key={p.pid}
                                        className="bd-row bd-proc"
                                        title={p.cmd}
                                      >
                                        <span>{p.name}</span>
                                        <span className="bd-nums">
                                          {p.cpu.toFixed(0)}% ·{" "}
                                          {fmtMem(p.mem_bytes)}
                                        </span>
                                      </div>
                                    ))}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    <div
                      className="bd-head"
                      title="Canopy's own engine, language servers and the agent hook bridge — everything not running inside a terminal"
                    >
                      <span>Core services</span>
                      <span className="bd-nums">
                        {Math.max(0, app.cpu - termCpu).toFixed(0)}% ·{" "}
                        {fmtMem(Math.max(0, app.mem_bytes - termMem))}
                      </span>
                    </div>
                    <div className="bd-row bd-proc">
                      Canopy engine · language servers · hook bridge
                    </div>
                    {allSessions.length === 0 && (
                      <div className="bd-row bd-proc">
                        {/* The monitor only reports terminals that exist, and
                            every 2s — so this is either "none open" or the
                            first tick hasn't landed yet. */}
                        No terminal sessions reporting (yet).
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </span>
      )}
      {(stats?.model || (onSetModel && modelSwitch)) && (
        <span className="status-item status-model-anchor">
          {onSetModel && modelSwitch ? (
            <button
              className="status-model-btn"
              title={
                modelSwitch.kind === "inline"
                  ? `Change this session's model (${modelSwitch.command})`
                  : `Choose this session's model — opens ${agentLabel ?? "the CLI"}'s own picker (${modelSwitch.command})`
              }
              onClick={(e) => {
                // A picker has one outcome, so a menu of one item would just be
                // a click in the way: go straight to the confirmation.
                if (modelSwitch.kind === "picker") {
                  setConfirmModel({ label: "a different model" });
                  return;
                }
                anchorMenu(e);
                setModelMenu((v) => !v);
              }}
            >
              {/* Only Claude's transcript tells us the model in play. For the
                  rest the button names the action instead of pretending to
                  know — the tab strip already says which CLI it is. */}
              {stats?.model ? `${stats.model.replace(/^claude-/, "")} ▾` : "model ▾"}
            </button>
          ) : (
            <span title="model (from Claude session transcript)">
              {stats?.model?.replace(/^claude-/, "")}
            </span>
          )}
          {modelMenu && modelSwitch?.kind === "inline" && (
            <div
              className="status-menu"
              style={menuStyle}
              onMouseLeave={() => setModelMenu(false)}
            >
              {modelSwitch.choices.map((m) => (
                <div
                  key={m.id}
                  className="cli-item"
                  onClick={() => {
                    setModelMenu(false);
                    setConfirmModel(m);
                  }}
                >
                  <span>{m.label}</span>
                  <span className="status-menu-hint">{m.hint}</span>
                </div>
              ))}
            </div>
          )}
        </span>
      )}
      {confirmModel && modelSwitch && (
        <div
          className="confirm-backdrop"
          onMouseDown={() => setConfirmModel(null)}
        >
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p>
              {modelSwitch.kind === "inline" ? (
                <>
                  Switch this session to <strong>{confirmModel.label}</strong>?
                </>
              ) : (
                <>Choose a model for this session?</>
              )}
            </p>
            <p className="confirm-sub">
              This types{" "}
              <code>{modelCommandLine(modelSwitch, confirmModel.id)}</code> into
              the {agentLabel ?? "agent"} terminal and submits it.{" "}
              {modelSwitch.kind === "inline"
                ? `${agentLabel ?? "The CLI"} applies it to the running session — if the new model has a smaller context window it will warn or compact in the terminal, so check its response there.`
                : `${agentLabel ?? "The CLI"} then opens its own model list in the terminal, where you pick — nothing changes until you do.`}{" "}
              If you have unsent text typed in that session's input box, it will
              be submitted along with the command.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmModel(null)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                onClick={() => {
                  onSetModel?.(confirmModel.id);
                  setConfirmModel(null);
                }}
              >
                {modelSwitch.kind === "inline" ? "Switch model" : "Open picker"}
              </button>
            </div>
          </div>
        </div>
      )}
      {stats && (stats.input_tokens > 0 || stats.output_tokens > 0) && (
        <span
          className="status-item"
          title={`in ${stats.input_tokens.toLocaleString()} · out ${stats.output_tokens.toLocaleString()} · cache read ${stats.cache_read_tokens.toLocaleString()} · ${stats.turns} turns`}
        >
          ↑{fmtTokens(stats.input_tokens + stats.cache_creation_tokens, true)} ↓
          {fmtTokens(stats.output_tokens, true)}
        </span>
      )}
      {cost != null && (
        <span
          className="status-item status-cost"
          title="estimated session cost"
        >
          ~${cost.toFixed(2)}
        </span>
      )}
      {/* Plan headroom, right of spend: the two answer different questions —
          what this session cost vs how much of the subscription is left — and
          only the CLIs that genuinely report limits get a chip. A CLI with no
          plan concept, or one that has not seen an API response yet, shows
          nothing rather than a 0% that would read as "plenty left". */}
      {plan && plan.windows.length > 0 && (
        <span
          className={`status-item status-plan is-${planTone(plan)}`}
          title={tooltip(plan)}
        >
          {chipText(plan)}
        </span>
      )}
      {/* Between the spend and the stats: the two things either side of it are
          what Canopy costs you and what it is doing, which is exactly where
          asking for support belongs. Opens in the system browser — a donate
          page has no business in the embedded preview, which is for the app you
          are building. */}
      <button
        className="status-item status-support"
        title="Support Canopy"
        onClick={() =>
          void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
            openUrl("https://canopyide.dev/support"),
          )
        }
      >
        <HeartIcon size={13} />
      </button>
      <span className="status-item status-stats-anchor" ref={statsAnchorRef}>
        <button
          className={`status-stats-btn ${statsOpen ? "is-open" : ""}`}
          title="Usage & cost across all CLIs"
          onClick={(e) => {
            anchorMenu(e);
            setStatsOpen((v) => !v);
          }}
        >
          <StatsIcon size={13} />
        </button>
        {statsOpen && (
          <div className="status-menu status-stats-menu" style={menuStyle}>
            <StatsPanel visible={statsOpen} />
          </div>
        )}
      </span>
      {branchMenu.menu && (
        <ContextMenu {...branchMenu.menu} onClose={branchMenu.close} />
      )}
    </div>
  );
});

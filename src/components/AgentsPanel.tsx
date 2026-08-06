// Agent management: one row per terminal session, named after whatever the pty
// has in its foreground (see agentIdentity.ts), with CPU/memory for the runaway
// guard.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { basename } from "../paths";
import { getSettings } from "../settings";
import { AGENT_CLIS } from "../projects";
import { agentDisplayName, type TabName } from "../agentDisplayName";
import {
  LIFE_META,
  NO_ATTENTION,
  agentLife,
  bucketFor,
  reclaimable,
  silenceLabel,
  type Attention,
} from "../../shared/agentLife";
import { ashFor } from "../ash";
import { markRestored } from "../restorable";
import { lastHumanPrompt, useAgentSessions } from "../agentSessions";
import { claimOwnerName } from "../claims";
import { AGENT_LABELS, IntegrationsList, useIntegrations } from "./AgentIntegrations";
import { PendingCard } from "./PendingCard";
import { Mascot } from "./Mascot";
import { AgentRuntime } from "./AgentRuntime";
import {
  AgentIcon,
  DiffIcon,
  ExchangeIcon,
  InstructionKindIcon,
  MoonIcon,
  RestartIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";
import { useEscape } from "../useEscape";
import type { PendingItem } from "../notifications";
import { Button } from "./ui";
import { format, matchesModifierClick } from "../shortcuts";

/** What shared context actually does, in one hover rather than one paragraph.
 *  Both halves of the header carry it, so it's there whether you reach for the
 *  question mark or the switch.
 *
 *  Written for someone deciding whether to turn it on: what each agent is told,
 *  what of yours that costs, and where the boundary is. The old copy also
 *  promised a session "never sees its own work", which is an implementation
 *  note phrased as a riddle — of course an agent knows what it just did. */
const SHARE_EXPLAIN =
  "Agents in this project can see what the others are up to. Before each prompt, an agent is told " +
  "the recent prompts you gave the other sessions here and the files they touched.";

interface AgentsPanelProps {
  /** False while another side tab is in front. The panel stays mounted (so
   *  its scroll and expanded rows survive a switch away) but stops polling
   *  session digests — nobody is looking. */
  visible: boolean;
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
  /** Open a detected server URL in the in-app preview tab (Cmd-click — Ctrl
   *  off a Mac — on the
   *  chip still opens the system browser). */
  onPreviewUrl?: (url: string) => void;
  /** Focus the tab a running session is in. Separate from onJumpToTerminal:
   *  that one guesses a tab from a notification's cwd, this one has the pty
   *  id in hand and is exact. */
  onJumpToPty?: (ptyId: number) => void;
  /** Open an agent's workspace tab: its files, diffs, commits and PR. Reached
   *  from the row's workspace chip, keyed on the live process — the digest,
   *  when a hook wrote one, is only enrichment. The row itself jumps to the
   *  terminal. */
  onOpenAgent?: (p: {
    agent: string;
    cwd: string;
    ptyId: number;
    sessionId?: string;
    digest?: ipc.SessionDigest;
  }) => void;
  /** The pty of the terminal tab currently in front, so its row can be
   *  highlighted — the reverse of onJumpToPty: relate the tab you're on back to
   *  its row in the list. Null when the active tab isn't a terminal. */
  activePty?: number | null;
  /** What each running pty's tab is called — the CLI's own title for it, and
   *  the user's rename when there is one. Rows are named from this, so the
   *  panel and the tab strip say the same thing about the same session. */
  tabNames?: Map<number, TabName>;
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
  /** Open the agent-instructions tab, optionally on one file. */
  onOpenInstructions?: (focus?: string) => void;
  /** Open the agents page — the same material with room for it. The panel is
   *  the glance; the page is where you go when the glance isn't enough. */
  onOpenAgentsPage?: () => void;
  /** Open one file claim as its own tab — who took it, why, and what it has
   *  turned away since. */
  onOpenClaim?: (claim: ipc.AgentClaim) => void;
  /** Which agent CLIs are on PATH, keyed by bin — decides which instruction
   *  formats are worth listing when the file doesn't exist yet. */
  installed?: Record<string, boolean>;
  /** The attention axis for one terminal — the same memory the tab strip
   *  reads (useAttentionMemory in ProjectView). Without it every row here fed
   *  `bucketFor`/`reclaimable` a constant NO_ATTENTION, which blanked the
   *  "needs you" chip and — worse — let auto-hibernation reclaim an agent the
   *  attention channel knew was blocked on you. */
  attentionFor?: (ptyId: number) => Attention;
}

/** How many agent messages the panel shows before "View all". The store keeps
 *  up to 500; a sidebar list that long buries the recent traffic it exists
 *  to surface. */
const MESH_TOP_N = 8;

/** One end of a message's route: the CLI's name when the hook captured it,
 *  else the bare terminal id. */
const meshEnd = (pty: number | null | undefined, agent?: string | null) =>
  pty == null ? "companion" : agent ? `${agent} ${pty}` : `terminal ${pty}`;

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

/** Exactly what the other sessions in this project are being told, verbatim.
 *
 *  A dialog rather than an expander under the switch: this is a wall of other
 *  people's prompts, and inline it pushed the running agents — the thing the
 *  panel is for — off the bottom of the screen. Opened from the count on the
 *  header line, so the panel itself stays one row. */
function SharedDialog({
  shared,
  onClose,
}: {
  shared: ipc.SessionDigest[];
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        <h3>What's shared</h3>
        <p className="share-modal-note">{SHARE_EXPLAIN}</p>
        {shared.length === 0 ? (
          <p className="share-none">Nothing yet — a session appears here once it runs a prompt.</p>
        ) : (
          shared.map((d) => {
            // The ladder's verdict, not the legacy `idle` boolean: that field
            // predates `state`, so absent read as "active" and a stale true
            // read as "idle" for a session long dead. No pty evidence reaches
            // this dialog, so the verdict decays on silence alone — the same
            // conservative half of the rule the workspace header applies.
            const life = agentLife({
              digest: d as never,
              now: Date.now() / 1000,
            });
            const meta = LIFE_META[life.state];
            return (
            <div key={d.session_id} className="share-digest">
              <div className="share-digest-head">
                {basename(d.cwd)}
                {d.branch && <span className="share-branch">⎇ {d.branch}</span>}
                <span className={`share-state ${meta.cls}`} title={life.note}>
                  {meta.label}
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
            );
          })
        )}
        <div className="modal-actions">
          <Button onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One group. The panel used to be five identical full-width lists with
 *  identical headings, so "running now" and "restorable from before" looked
 *  the same — the indented body plus a rule is what separates them. */
function Section({
  title,
  count,
  tone,
  action,
  collapseKey,
  children,
}: {
  title: string;
  count?: number;
  tone?: "urgent" | "quiet";
  action?: React.ReactNode;
  /** Set to make the section collapsible. It starts collapsed, and the choice
   *  is remembered under this key — a panel section you closed should stay
   *  closed the next time you open the project. */
  collapseKey?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(
    () => collapseKey != null && localStorage.getItem(`canopy.section.${collapseKey}`) === "1",
  );
  const toggle = () => {
    if (collapseKey == null) return;
    setOpen((v) => {
      localStorage.setItem(`canopy.section.${collapseKey}`, v ? "0" : "1");
      return !v;
    });
  };
  const collapsible = collapseKey != null;
  return (
    <div className={`ap-section ${tone ? `ap-section-${tone}` : ""}`}>
      <div
        className={`ap-head ${collapsible ? "ap-head-toggle" : ""}`}
        onClick={collapsible ? toggle : undefined}
      >
        {collapsible && (
          <span className="tree-chevron">{open ? "▾" : "▸"}</span>
        )}
        <span className="ap-title">{title}</span>
        {count != null && count > 0 && <span className="badge">{count}</span>}
        <span className="ap-head-spacer" />
        {/* Actions live inside the header, so their clicks must not also
            toggle it. */}
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </div>
      {(!collapsible || open) && <div className="ap-body">{children}</div>}
    </div>
  );
}

export function AgentsPanel({
  visible,
  stats,
  hookPath,
  pending = [],
  onDismissPending,
  onAnswer,
  onJumpToTerminal,
  onJumpToPty,
  onPreviewUrl,
  onOpenAgent,
  activePty,
  tabNames,
  roots,
  shareContext,
  onShareContext,
  liveSessionIds = [],
  onRestore,
  onRespond,
  onNotice,
  onOpenInstructions,
  onOpenAgentsPage,
  onOpenClaim,
  installed = {},
  attentionFor,
}: AgentsPanelProps) {
  // A host that wires no attention memory gets the old constant — "no claim
  // either way" — never a crash. Everything below must go through this, not
  // NO_ATTENTION directly. Memoized because the auto-hibernation effect
  // depends on it: a fresh fallback closure per render is the every-render
  // effect this panel just got rid of.
  const attentionOf = useMemo(
    () => attentionFor ?? (() => NO_ATTENTION),
    [attentionFor],
  );
  // Instruction files: scanned once when the panel comes into view, and again
  // when the project's roots change. It's a bounded filesystem walk, but it is
  // still a walk — so nothing runs while another side tab is in front, and the
  // dependency is the roots' *contents*, not the array: ProjectView rebuilds
  // that array every render, and keying on its identity would re-walk the
  // filesystem on every agent event that ticks the view. Same idiom as the
  // termSessions effect below.
  // null until the first scan lands (and again if it fails) — an empty array
  // would render "no instruction files yet", which is a claim, not a wait.
  const [instructionFiles, setInstructionFiles] = useState<ipc.InstructionFile[] | null>(null);
  const [instructionsFailed, setInstructionsFailed] = useState(false);
  const rootsKey = roots.join("\n");
  useEffect(() => {
    if (!visible || rootsKey === "") return;
    let live = true;
    void ipc
      .instructionsScan(rootsKey.split("\n"))
      .then((fs) => {
        if (!live) return;
        setInstructionFiles(fs);
        setInstructionsFailed(false);
      })
      .catch(() => live && setInstructionsFailed(true));
    return () => {
      live = false;
    };
  }, [visible, rootsKey]);

  /** What to show in a panel this narrow: the files that exist, plus — for the
   *  CLIs actually installed here — the top-level ones that don't yet, since
   *  "you have no CLAUDE.md" is the most useful thing this list can tell you. */
  const headlineInstructions = useMemo(() => {
    const files = instructionFiles ?? [];
    const installedIds = new Set(
      AGENT_CLIS.filter((c) => installed[c.bin]).map((c) => c.id),
    );
    const exists = files.filter((f) => f.exists && f.kind === "instructions");
    const missing = files.filter(
      (f) =>
        !f.exists &&
        f.kind === "instructions" &&
        f.scope === "project" &&
        f.agents.some((a) => installedIds.has(a)),
    );
    return { rows: [...exists, ...missing], live: exists.length };
  }, [instructionFiles, installed]);
  const [showHookHelp, setShowHookHelp] = useState(false);
  // Which of the running CLIs have no hooks — not a single boolean over all of
  // them. `every` called a mixed roster (claude hooked, aider not) uninstalled
  // and told the user nothing was streaming when most of it was, then re-ran
  // setup across the lot; `some` would have under-reported the same way. null
  // while we haven't checked, so the nudge never flashes the wrong message.
  const [unhooked, setUnhooked] = useState<string[] | null>(null);
  // Per-CLI integration state, so "why is this agent silent?" has an answer in
  // the panel rather than in a config file the user has to go and read. Read
  // only while the help is open — that is the only place the panel shows it.
  const integrations = useIntegrations(showHookHelp);
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
  const [showShared, setShowShared] = useState(false);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const settings = getSettings();

  // What is running, what can come back, and who has claimed what — the same
  // read the agents page makes. An agent session and a plain shell answer
  // different questions ("what is it working on?" vs "what's running in it?"),
  // so they get separate heads; every session appears under exactly one.
  const {
    sessions,
    agentSessions,
    termSessions,
    restorable,
    shared,
    claims,
    messages,
    forget,
    lifeOf,
  } =
    useAgentSessions({ visible, roots, stats, liveSessionIds });

  // Agents are running but not one of them has a digest — nothing is streaming
  // from their hooks, which is exactly why a question or task never appears in
  // this panel. A single digest anywhere proves hooks work, so this only fires
  // when they're genuinely not wired up. Nudge the one-click setup rather than
  // leave the panel silently blind.
  const noHookSignal =
    agentSessions.length > 0 && agentSessions.every((x) => !x.digest);
  // Only offer setup for CLIs whose configuration Canopy knows how to edit.
  // Unknown agents remain visible, but we must not imply they have a safe
  // one-click integration path.
  const setupAgents = useMemo(
    () =>
      [...new Set(agentSessions.map((x) => x.agent?.id).filter((id): id is string => !!id))].filter(
        (id) => AGENT_LABELS.some((a) => a.id === id),
      ),
    [agentSessions],
  );
  // The dependency the effect below actually reads. Hoisted so the array holds
  // a value rather than an expression over one, which is what lint can check.
  const setupKey = setupAgents.join(",");

  // No digest could mean hooks aren't installed OR that these agents were
  // started before they were — opposite fixes. Ask the backend which it is, so
  // the panel offers "set up" only when they're genuinely missing and otherwise
  // says "restart to stream". Re-checked whenever the silence appears (e.g.
  // right after a one-click setup), never polled.
  useEffect(() => {
    if (!noHookSignal || setupAgents.length === 0) {
      setUnhooked(null);
      return;
    }
    void Promise.all(
      setupAgents.map(async (agent) => ({ agent, ok: await ipc.agentHooksInstalled(agent) })),
    )
      .then((rows) => setUnhooked(rows.filter((r) => !r.ok).map((r) => r.agent)))
      // Back to "don't know" rather than leaving the last answer up: a
      // transient IPC failure must not keep a banner on screen that describes
      // a state we can no longer confirm.
      .catch(() => setUnhooked(null));
  }, [noHookSignal, setupKey, integrations.result]);

  // Hibernate an agent: kill its terminal to reclaim the memory, keeping the
  // session digest (which is already the restore record) so the row reappears
  // under "Restorable" and its own --resume brings it back with history.
  const hibernate = (id: number) => void ipc.ptyKill(id);

  // Auto-hibernation. Reclaim the stalest *provably finished* agents once a
  // project is over its cap — never one mid-turn, never one blocked on the
  // user, never one we have merely lost track of, and never twice (a killed pty
  // lingers in `stats` until the next poll, and pty ids are monotonic within a
  // run, so a set of ids we've already reclaimed is enough to keep the toast
  // from repeating and ptyKill from firing on the dead).
  //
  // This filtered on the raw recorded state, which is how it came to SIGTERM
  // live sessions. Two ways in: aider's only integration classified both "turn
  // finished" and "waiting at a y/n confirm" as idle, and a digest written by a
  // session that has since gone keeps saying whatever it last said. Neither is
  // fixed by ageing the state — the decay function this replaces could only
  // rewrite an over-confident `working`, so routing this line through it
  // produced a byte-identical victim set. `reclaimable` demands the *rung* be
  // structural, which is the corroboration that was missing.
  //
  // Expect this to reclaim less than it used to. Five of seven CLIs cannot emit
  // a session-end event at all, so for those the cap is only enforced once a
  // turn provably ends; the toast says so rather than silently doing nothing.
  const hibernatedRef = useRef<Set<number>>(new Set());
  // Which roster the refusal toast last spoke for. The effect re-runs on every
  // stats tick (cpu numbers move, so `agentSessions` recomputes), and without
  // this the "nothing was reclaimed" branch re-toasted every ~2 seconds for as
  // long as the project stayed over the cap — the refusal is worth saying once
  // per roster, not once per poll.
  const refusedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settings.autoHibernate) return;
    const cap = Math.max(1, settings.maxLiveAgents);
    const live = agentSessions.filter((x) => !hibernatedRef.current.has(x.session.id));
    if (live.length <= cap) {
      refusedForRef.current = null;
      return;
    }
    const spare = live
      // The real attention, per pty: reclaimable's guard exists precisely so
      // the cap cannot kill an agent the attention channel knows is blocked
      // on you, and feeding it NO_ATTENTION here disarmed that guard.
      .filter((x) => reclaimable(lifeOf(x), attentionOf(x.session.id)))
      .sort((a, b) => (a.digest?.updated ?? 0) - (b.digest?.updated ?? 0));
    const victims = spare.slice(0, live.length - cap);
    for (const v of victims) {
      hibernatedRef.current.add(v.session.id);
      hibernate(v.session.id);
    }
    if (victims.length > 0) {
      refusedForRef.current = null;
      onNotice?.(
        `Hibernated ${victims.length} idle agent${
          victims.length > 1 ? "s" : ""
        } to free memory — resume from Restorable.`,
      );
    } else {
      // Saying nothing here is what makes "the cap is not working" look like a
      // bug rather than a refusal — but say it once per roster.
      const key = live.map((x) => x.session.id).join(",");
      if (refusedForRef.current !== key) {
        refusedForRef.current = key;
        onNotice?.(
          `Over the agent cap, but none of these have provably finished — nothing was reclaimed.`,
        );
      }
    }
  }, [agentSessions, settings.autoHibernate, settings.maxLiveAgents, onNotice, lifeOf, attentionOf]);

  const sessionRow = (row: (typeof sessions)[number]) => {
    const { session: s, agent, dir, digest } = row;
    const runaway =
      s.total_cpu > settings.runawayCpuPercent ||
      s.total_mem_bytes > settings.runawayMemBytes;
    // Lifecycle dot: only for agent rows the hook stream has spoken for, and
    // only believed as far as the session's own activity backs it up — a CLI
    // that stops without a Stop event leaves "working" behind forever.
    const life = lifeOf(row);
    const shown = life.state;
    const st = agent ? LIFE_META[shown] : undefined;
    const stTitle =
      shown === "unknown"
        ? `${life.note} (silent for ${silenceLabel(digest?.updated, Date.now() / 1000)})`
        : life.note || st?.label;
    // Only reclaim an agent that has *provably* finished — never one mid-turn,
    // never one blocked, and never one we have merely lost track of. The
    // confidence check is the part that matters: aider's whole lifecycle used
    // to read `idle` (its one integration shipped a message Canopy wrote and
    // then re-parsed into "finished"), so this button offered to kill a session
    // sitting on a y/n confirm.
    const canHibernate = !!agent && reclaimable(life, attentionOf(s.id));
    // What the human last asked for. The highest-signal line about a session:
    // "fix the login redirect" identifies it in a way that cpu, memory and a
    // directory never will.
    const task = lastHumanPrompt(digest?.prompts);
    // What to call this row. Its tab's name first — the CLI titles that tab
    // with what it is working on, and the user can rename it — so the panel
    // never shows a column of identical "claude"s while the tab strip above it
    // is naming the same sessions apart.
    const name = agentDisplayName({
      tab: tabNames?.get(s.id),
      agentLabel: agent?.label,
      sessionTitle: s.title,
    });
    return (
      <div
        key={s.id}
        className={`agent-row ${runaway ? "agent-runaway" : ""} ${
          onJumpToPty ? "agent-row-jump" : ""
        } ${s.id === activePty ? "agent-row-active" : ""}`}
        // Clicking a row jumps to the live session — the active thing you're
        // steering. The workspace (files, diffs, commits, PR) is one chip away
        // for agent rows; it isn't the row's job to open it. Plain shells only
        // ever had a terminal to jump to, so they're unchanged.
        onClick={() => onJumpToPty?.(s.id)}
        // Rows truncate to one line each now; the full detail lives here.
        title={[
          // The row's name, then which CLI it is — now that the name is the
          // tab's, the row no longer says that on its face.
          name,
          agent && name !== agent.label
            ? `${agent.label} (identified by ${agent.via})`
            : agent
              ? `identified by ${agent.via}`
              : undefined,
          s.cwd,
          digest?.branch,
          task,
          "Click to jump to this terminal",
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <div className="agent-main">
          {/* Lifecycle at a glance: green pulse = working, amber = waiting on
              you, grey = idle, faded = ended. */}
          {st &&
            (() => {
              const look = ashFor(shown);
              return (
                <Mascot
                  state={look.state}
                  tone={look.tone}
                  size={16}
                  className="agent-state-ash"
                  title={stTitle}
                />
              );
            })()}
          {/* The CLI's own mark, not its name in bold — the panel is a column
              of near-identical rows and a glyph reads faster than a word. */}
          {/* No id means we can see the program but cannot name whose it
              is — it gets the plain terminal glyph rather than a guess at a
              brand. */}
          {agent?.id ? (
            <AgentIcon id={agent.id} size={14} className="ap-mark" />
          ) : (
            <TerminalIcon size={13} className="ap-mark" />
          )}
          <span className="agent-name">{name}</span>
          {/* How long it has actually been working: this stretch while it is
              working, the session's total once it stops. Ahead of the directory
              and branch chips because this row truncates rather than wraps, and
              a timer clipped off the end is a timer that is not there — those
              two ellipsize gracefully, a stopwatch does not. Both numbers are
              in the tooltip, and in the agent's workspace tab.

              Live only while `shown` says it is genuinely working: a CLI that
              dies mid-turn leaves "working" behind forever, and a clock counting
              up from that would invent hours of work it never did. */}
          {agent && <AgentRuntime timing={digest} live={shown === "working"} />}
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
          {/* Which account it is spending — two agents of the same CLI on one
              branch are otherwise identical rows. */}
          {digest?.profile && digest.profile !== "default" && (
            <span
              className="agent-account"
              title={`Running under the "${digest.profile}" account`}
            >
              {digest.profile}
            </span>
          )}
          {/* Blocked on you, stated on the row itself so it survives whether
              or not the transient card is up and whichever tab is focused —
              the durable "needs input" signal, not a fleeting event. */}
          {bucketFor(life, attentionOf(s.id)) === "attention" && (
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
          {/* The row jumps to the terminal; this chip is the one way to the
              workspace — files, diffs, commits and PR — keyed on the live
              process. Only agent rows have a workspace to open. */}
          {agent?.id && onOpenAgent && (
            <button
              className="agent-session agent-session-icon"
              title="Open this agent's workspace — files, diffs, commits and PR"
              onClick={(e) => {
                e.stopPropagation();
                onOpenAgent({
                  agent: agent.id ?? "agent",
                  cwd: s.cwd,
                  ptyId: s.id,
                  sessionId: digest?.session_id,
                  digest,
                });
              }}
            >
              <DiffIcon size={12} />
            </button>
          )}
          {/* A dev server in here, without opening the tab to find out. */}
          {s.ports?.map((p) => (
            <button
              key={p}
              className="agent-port"
              title={
                onPreviewUrl
                  ? `Preview http://localhost:${p} in Canopy — ${format(
                      "open-external",
                    )}-click for your browser`
                  : `Open http://localhost:${p} in your browser`
              }
              onClick={(e) => {
                e.stopPropagation();
                if (onPreviewUrl && !matchesModifierClick(e, "open-external")) {
                  onPreviewUrl(`http://localhost:${p}`);
                } else {
                  void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                    openUrl(`http://localhost:${p}`),
                  );
                }
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
            <Button icon
              title="Hibernate — frees memory now; resume later from Restorable with its history"
              onClick={(e) => {
                e.stopPropagation();
                hibernate(s.id);
              }}>
              <MoonIcon size={12} />
            </Button>
          )}
          <Button icon variant="danger"
            title={`Kill terminal #${s.id}${agent ? ` and the ${agent.label} running in it` : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              void ipc.ptyKill(s.id);
            }}>
            ✕
          </Button>
        </div>
      </div>
    );
  };

  // Blocked-on-you vs merely-finished: the same stream, very different urgency.
  const urgent = pending.filter((i) => i.kind !== "idle");
  const idle = pending.filter((i) => i.kind === "idle");

  return (
    <div className="side-panel">
      {urgent.length > 0 && (
        <>
          <div className="side-panel-head">
            <span>Needs your input</span>
            <span className="badge">{urgent.length}</span>
          </div>
          {urgent.map((item) => (
            <PendingCard
              key={item.key}
              item={item}
              onAnswer={onAnswer}
              onRespond={onRespond}
              onJumpToTerminal={onJumpToTerminal}
              onDismiss={onDismissPending}
            />
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
            <PendingCard
              key={item.key}
              item={item}
              onJumpToTerminal={onJumpToTerminal}
              onDismiss={onDismissPending}
            />
          ))}
        </>
      )}
      {/* What every agent here reads before it sees any code. A count and the
          headline files; the tab is where they're actually edited. */}
      <Section
        title="Instructions"
        // The count is what the list below shows — the instruction files in
        // effect. Counting every scanned file put "143" (mostly global skills)
        // over a list of four.
        count={headlineInstructions.live}
        // Collapsed until asked for: instruction files change rarely, and this
        // list sat between the pending questions and the running agents — the
        // two things the panel exists for.
        collapseKey="instructions"
        action={
          <Button icon
            title="Open all agent instructions — CLAUDE.md, AGENTS.md, skills, subagents"
            onClick={() => onOpenInstructions?.()}>
            ⤢
          </Button>
        }
      >
        {instructionsFailed ? (
          <div className="tree-empty">Couldn't look for instruction files.</div>
        ) : instructionFiles === null ? (
          <div className="tree-empty">Looking…</div>
        ) : headlineInstructions.rows.length === 0 ? (
          <div className="tree-empty">
            No instruction files yet. Agents here start with nothing but your prompt —
            open this to write the first one.
          </div>
        ) : (
          headlineInstructions.rows.slice(0, 6).map((f) => (
            // Same mark as the Instructions tab: the CLI's logo when one CLI
            // owns the file, the kind's shape when several read it.
            <div className="task-row" key={f.path}>
              <span className={`instr-row-icon ${f.exists ? "" : "is-missing"}`}>
                {f.agents.length === 1 ? (
                  <AgentIcon id={f.agents[0]} size={13} />
                ) : (
                  <InstructionKindIcon kind={f.kind} size={13} />
                )}
              </span>
              <span
                className={`task-label task-label-link ${f.exists ? "" : "task-label-dim"}`}
                title={`${f.path}\nRead by ${f.agents.join(", ")}`}
                onClick={() => onOpenInstructions?.(f.path)}
              >
                {f.title ?? f.label}
              </span>
              {!f.exists && <span className="task-note">create</span>}
            </div>
          ))
        )}
      </Section>

      {/* Shared context — opt-in, and always inspectable, in one line.
          The four-line explanation is a tooltip: it is read once, and it was
          costing a permanent block of a panel whose job is to show what the
          agents are doing right now. What's actually shared is a click away in
          a dialog rather than an expander, because it is a wall of other
          sessions' prompts and it was pushing the running agents off screen.
          The mark tells this row apart from the section headings around it —
          it is a switch, not a list. */}
      <div className="side-panel-head share-head">
        <span className="share-head-title">
          <ExchangeIcon size={13} />
          Shared context
        </span>
        <span className="side-head-actions">
          {shareContext && (
            <button
              className="share-peek"
              title="See exactly what the other sessions are being told"
              onClick={() => setShowShared(true)}
            >
              {shared.length} shared
            </button>
          )}
          <span className="share-hint" title={SHARE_EXPLAIN}>
            ?
          </span>
          <label className="share-toggle" title={SHARE_EXPLAIN}>
            <input
              type="checkbox"
              checked={shareContext}
              onChange={(e) => onShareContext(e.target.checked)}
            />
            <span>{shareContext ? "on" : "off"}</span>
          </label>
        </span>
      </div>
      {showShared && <SharedDialog shared={shared} onClose={() => setShowShared(false)} />}

      <Section
        title="Running agents"
        count={agentSessions.length}
        action={
          <>
            {/* The same material with room for it: cards instead of one-line
                rows, the archive searchable, and the integrations out in the
                open. The panel stays the glance. */}
            {onOpenAgentsPage && (
              <Button icon
                title="Open the agents page — every session, with room to read it"
                onClick={onOpenAgentsPage}>
                ⤢
              </Button>
            )}
            <Button icon
              title="How to hook up agent CLIs"
              onClick={() => setShowHookHelp((v) => !v)}>
              ?
            </Button>
          </>
        }
      >

      {/* Hooks genuinely absent — offer the one-click setup. */}
      {noHookSignal && !showHookHelp && unhooked !== null && unhooked.length > 0 && (
        <div className="hook-nudge">
          <span>
            No events are streaming in from{" "}
            {unhooked.map((id) => AGENT_LABELS.find((a) => a.id === id)?.label ?? id).join(", ")} —
            questions, tasks and tokens won't show until hooks are set up.
          </span>
          <Button variant="accent" onClick={() => void integrations.setUp(unhooked)}>
            Set up agent integrations
          </Button>
          {integrations.result && <p className="hook-result">{integrations.result}</p>}
        </div>
      )}

      {/* Hooks are installed; these agents just predate them. Say the thing that
          actually fixes it (restart) instead of the setup button, and let it be
          dismissed — otherwise it nags in every project forever. */}
      {noHookSignal && !showHookHelp && unhooked?.length === 0 && !hintDismissed && (
        <div className="hook-nudge">
          <span>
            Hooks are set up, but these agents started before that — restart one
            to stream its questions, tasks and tokens here.
          </span>
          <Button onClick={dismissHint}>
            Got it
          </Button>
        </div>
      )}

      {showHookHelp && hookPath && (
        <div className="hook-help">
          <p>Stream tool-use events from agent CLIs into this panel:</p>
          <IntegrationsList
            health={integrations.health}
            onSetUp={(a) => void integrations.setUp(a)}
          />
          {integrations.result && <p className="hook-result">{integrations.result}</p>}
          <p>
            Other CLIs: point any hook at appending single-line JSON to:
          </p>
          <code className="hook-path">{hookPath}</code>
        </div>
      )}

      {agentSessions.length === 0 ? (
        <div className="tree-empty ash-scene">
          <Mascot state="sleeping" size={64} />
          <div>
            No agents running. Launch <code>claude</code>, <code>codex</code>, etc. from the ＋
            menu or by right-clicking a component.
          </div>
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

      {/* Files an agent has claimed (canopy_claim). Advisory, so it only works
          if it is visible — and if a dead session's claim can be dropped. The
          row opens the claim: at this width it can only ever show a name and
          some filenames, and every other question about a claim is a sentence
          long. */}
      {claims.length > 0 && (
        <Section title="Claimed files" count={claims.length} tone="quiet">
          <div className="claim-list">
            {claims.map((claim) => (
              <div
                key={claim.id}
                className={`claim-row ${onOpenClaim ? "claim-row-open" : ""}`}
                title={`${claim.owner}\n${claim.paths.join("\n")}${
                  onOpenClaim ? "\nClick to open this claim" : ""
                }`}
                onClick={() => onOpenClaim?.(claim)}
              >
                <span className="claim-owner">{claimOwnerName(claim.owner)}</span>
                <span className="claim-paths">
                  {claim.note ? `${claim.note} — ` : ""}
                  {claim.paths.map((p) => basename(p)).join(", ")}
                </span>
                {/* A contested file is the most useful thing this list can
                    say — until now the turned-away agents were only visible
                    inside an already-open claim tab. */}
                {claim.refusals.length > 0 && (
                  <span
                    className="claim-refusals"
                    title={`${claim.refusals.length} other claim${
                      claim.refusals.length === 1 ? "" : "s"
                    } on these files ${
                      claim.refusals.length === 1 ? "was" : "were"
                    } turned away — open the claim to see who`}
                  >
                    ⛔ {claim.refusals.length}
                  </span>
                )}
                <Button
                  title="Drop this claim — for an agent that died holding it"
                  onClick={(e) => {
                    e.stopPropagation();
                    // A release that failed and said nothing looks exactly
                    // like a claim that won't die.
                    void ipc
                      .contextReleaseClaim(claim.owner_key)
                      .catch((err) =>
                        onNotice?.(`Couldn't release this claim: ${err}`),
                      );
                  }}>
                  Release
                </Button>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Messages agents have typed into each other (canopy_message_agent).
          One arrives in its target's composer indistinguishable from the user
          typing, so without this the only trace of one agent reaching into
          another was a toast that had already gone. Newest first and capped to
          the recent few — a busy mesh writes hundreds, and the rest are one
          click away rather than one scroll. */}
      {messages.length > 0 && (
        <Section title="Agent messages" count={messages.length} tone="quiet">
          <div className="mesh-msg-list">
            {[...messages]
              .reverse()
              .slice(0, showAllMessages ? messages.length : MESH_TOP_N)
              .map((m) => (
              <div
                key={m.id}
                className={`mesh-msg ${m.submitted ? "" : "mesh-msg-unsent"}`}
                title={[
                  `${m.from_cwd ?? "the Canopy companion"} → terminal ${m.to_pty_id}`,
                  m.from_task ? `from: ${m.from_task}` : null,
                  m.to_task ? `to: ${m.to_task}` : null,
                  new Date(m.at_ms).toLocaleString(),
                  "",
                  m.text,
                ]
                  .filter((l) => l != null)
                  .join("\n")}
              >
                <span className="mesh-msg-route">
                  {meshEnd(m.from_pty_id, m.from_agent)}
                  {" → "}
                  {meshEnd(m.to_pty_id, m.to_agent)}
                </span>
                <span className="mesh-msg-text">{m.text}</span>
                {!m.submitted && (
                  <span
                    className="mesh-msg-flag"
                    title="The terminal went away before the return that submits it — this may still be sitting unsent in its composer."
                  >
                    unsent
                  </span>
                )}
                <span className="mesh-msg-when">{ago(m.at_ms / 1000)}</span>
              </div>
            ))}
          </div>
          {messages.length > MESH_TOP_N && (
            <button
              className="research-more"
              onClick={() => setShowAllMessages((v) => !v)}
            >
              {showAllMessages
                ? "Show recent only"
                : `View all ${messages.length} messages`}
            </button>
          )}
        </Section>
      )}

      {restorable.length > 0 && (
        <Section title="Restorable sessions" count={restorable.length} tone="quiet">
          <div className="restore-help">
            Not open right now — reopening runs the agent's own resume, so it
            comes back with its history.
          </div>
          {restorable.map(({ digest: d, agentId, cwd: runIn, command: cmd, superseded }) => {
            // runIn is resume_cwd, not cwd: claude looks the conversation up
            // under its project root, so resuming from the subdirectory the
            // agent ran in reports "No conversation found".
            const dir = basename(runIn);
            const last = lastHumanPrompt(d.prompts);
            return (
              <div key={d.session_id} className="restore-row">
                <div className="restore-main">
                  <AgentIcon id={agentId} size={14} className="ap-mark" />
                  <span className="agent-name">{agentId}</span>
                  {/* What this session got done before it went away. Never live
                      here, so it reads as a finished total. */}
                  <AgentRuntime timing={d} live={false} />
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
                  {/* Always a real offer: a session the CLI can't reopen by id,
                      or that wrote no transcript to reopen, never reaches this
                      list — see restorableFrom. */}
                  <button
                    className="row-act row-act-go"
                    title={`Restore this session — ${cmd}`}
                    onClick={() => {
                      // Bridge the gap until the resumed agent's first hook
                      // event rewrites the digest's surface; without it the row
                      // sits here looking un-restored for a few seconds.
                      markRestored(d.session_id);
                      onRestore?.(runIn, cmd, agentId, agentId);
                    }}
                  >
                    <RestartIcon size={13} />
                    <span className="row-act-label">Restore</span>
                  </button>
                  <button
                    className="row-act row-act-del"
                    title={
                      superseded.length > 0
                        ? `Forget this directory's ${superseded.length + 1} sessions — removes them from this list`
                        : "Forget this session — removes it from this list"
                    }
                    // The row stands for its whole directory (see
                    // newestPerDirectory), so forgetting only the session on
                    // show would just promote the next one behind it.
                    onClick={() => forget([d, ...superseded])}
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

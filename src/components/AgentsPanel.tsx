// Agent management: one row per terminal session, named after whatever the pty
// has in its foreground (see agentIdentity.ts), with CPU/memory for the runaway
// guard.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { AGENT_CLIS } from "../projects";
import { identifyAgent, observeForLearning } from "../agentIdentity";
import { agentDisplayName, type TabName } from "../agentDisplayName";
import { effectiveState, silenceLabel } from "../agentState";
import { ashFor } from "../ash";
import { forgetSessions, markRestored, restorableFrom } from "../restorable";
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

/** Colour + label for the lifecycle dot on a running-agent row. `working` is
 *  the only state that pulses — a moving dot in a column of still ones is
 *  where the eye lands first. `stale` is what `working` decays into when
 *  nothing corroborates it (see agentState.ts): pointedly not `idle`, because
 *  a session that stopped telling us anything has not told us it finished. */
export const STATE_META: Record<string, { cls: string; label: string }> = {
  working: { cls: "st-working", label: "working" },
  waiting: { cls: "st-waiting", label: "waiting on you" },
  idle: { cls: "st-idle", label: "idle — finished a turn" },
  ended: { cls: "st-ended", label: "session ended" },
  stale: { cls: "st-stale", label: "no signal — may have stopped" },
};

/** CLIs whose approval prompt is a numbered/Escape menu we can drive by
 *  synthesising keystrokes. Anything else gets "answer in terminal" instead of
 *  buttons that might type into the wrong UI. */
const KEYSTROKE_APPROVAL_AGENTS = new Set(["claude", "codex"]);

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

/** Every CLI with an auto-setup arm, in the order the integrations list shows
 *  them. Mirrors SUPPORTED_AGENTS in agents.rs. */
const AGENT_LABELS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "agy", label: "Antigravity" },
  { id: "aider", label: "Aider" },
  { id: "opencode", label: "OpenCode" },
  { id: "omp", label: "oh-my-pi" },
  { id: "amp", label: "Amp" },
];

const HEALTH_TONE: Record<string, string> = {
  ours: "hs-ok",
  missing: "hs-warn",
  foreign: "hs-warn",
  unreadable: "hs-warn",
  unsupported: "hs-none",
};

/** Spelled out because "foreign" and "unsupported" look like problems and only
 *  one of them is. */
const HEALTH_HELP: Record<string, Record<string, string>> = {
  hooks: {
    ours: "This CLI's config points its events at Canopy",
    missing: "No Canopy hooks in this CLI's config — nothing will stream in",
  },
  mcp: {
    ours: "The Canopy MCP server is registered for this CLI",
    missing: "Not registered — this CLI's agents can't ask the IDE for context",
    foreign:
      "An MCP server named 'canopy' exists here that Canopy didn't write. It is left alone — rename or remove it, then set up again.",
    unreadable: "This CLI's MCP config exists but can't be parsed",
    unsupported: "This CLI has no MCP configuration Canopy can write",
  },
};

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
  /** Which agent CLIs are on PATH, keyed by bin — decides which instruction
   *  formats are worth listing when the file doesn't exist yet. */
  installed?: Record<string, boolean>;
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
  installed = {},
}: AgentsPanelProps) {
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
  const [setupResult, setSetupResult] = useState<string | null>(null);
  // Which of the running CLIs have no hooks — not a single boolean over all of
  // them. `every` called a mixed roster (claude hooked, aider not) uninstalled
  // and told the user nothing was streaming when most of it was, then re-ran
  // setup across the lot; `some` would have under-reported the same way. null
  // while we haven't checked, so the nudge never flashes the wrong message.
  const [unhooked, setUnhooked] = useState<string[] | null>(null);
  // Per-CLI integration state, so "why is this agent silent?" has an answer in
  // the panel rather than in a config file the user has to go and read.
  const [health, setHealth] = useState<ipc.IntegrationHealth[]>([]);
  const refreshHealth = () =>
    ipc.agentIntegrationHealth().then(setHealth).catch(() => {});
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
  // multi-select (still one page) collects picks and submits together. A
  // multi-question form is a different beast: answering it means navigating
  // between pages, and driving that by synthesised keystrokes desyncs and the
  // CLI records "declined". Until Canopy answers questions over the programmatic
  // channel (headless `canUseTool`) rather than the TUI, a multi-page form is
  // answered in the terminal — the panel points there instead of miscounting.
  const instantAnswer = (item: PendingItem) =>
    (item.questions?.length ?? 0) === 1 && !item.questions?.[0]?.multiSelect;
  const multiPage = (item: PendingItem) => (item.questions?.length ?? 0) > 1;
  const canAnswerInPanel = (item: PendingItem) => !!onAnswer && !multiPage(item);
  const [digests, setDigests] = useState<ipc.SessionDigest[]>([]);
  // This app launch's tag, so a digest from another instance/run (same reset-to-1
  // PTY id, same shared sessions dir) can't be paired with our terminals.
  const [thisInstance, setThisInstance] = useState<string | null>(null);
  useEffect(() => {
    void ipc.instanceId().then(setThisInstance).catch(() => {});
  }, []);
  const [showShared, setShowShared] = useState(false);
  const settings = getSettings();

  // What the hook would actually inject — mirrors peer_context in
  // canopy_hook.rs: no "ended" sessions, and none quiet for longer than
  // PEER_MAX_AGE_SECS. The panel must apply the same rules or it claims
  // long-dead sessions are shared: a digest outlives its terminal (that's
  // what makes restore work), and one whose terminal died without a Stop
  // event even stays "active" on disk — the age cutoff is what ages those out.
  // `digests` itself stays unfiltered — it is also the crash-restore record.
  const PEER_MAX_AGE_SECS = 30 * 60;
  const shared = useMemo(
    () =>
      digests.filter(
        (d) =>
          d.state !== "ended" &&
          Date.now() / 1000 - (d.updated ?? 0) <= PEER_MAX_AGE_SECS,
      ),
    [digests],
  );

  // Loaded regardless of the sharing toggle: these digests are also the crash
  // record that "Restore sessions" reads. Sharing is about what agents see of
  // each other; restore is about what the *user* lost when the IDE died.
  useEffect(() => {
    if (!visible) return;
    const load = () =>
      void ipc
        .sessionDigests(roots)
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
  }, [roots.join("\n"), visible]);

  // Claims other agents hold in this checkout, refreshed when one changes.
  const [claims, setClaims] = useState<ipc.AgentClaim[]>([]);
  useEffect(() => {
    if (!visible) return;
    const load = () => void ipc.contextClaims().then(setClaims).catch(() => {});
    load();
    let un: (() => void) | undefined;
    void ipc.onAgentClaims(load).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [visible]);

  // Read the integrations when the help panel opens (that's the only place
  // they're shown) and whenever the startup pass reports in, so a repair that
  // happened while the panel was open is reflected without a manual refresh.
  useEffect(() => {
    if (!showHookHelp) return;
    void refreshHealth();
    let un: (() => void) | undefined;
    void ipc.onIntegrationHealth((r) => setHealth(r.agents)).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [showHookHelp]);

  // allSettled, not all: one CLI whose config can't be written must not erase
  // the report for the others. `Promise.all` rejected on the first failure and
  // showed that error alone, so a single unparseable registry made a setup that
  // wired up three CLIs look like it had done nothing at all.
  const autoSetup = async (agents: string | string[]) => {
    const ids = Array.isArray(agents) ? agents : [agents];
    const results = await Promise.allSettled(ids.map((agent) => ipc.setupAgentHooks(agent)));
    setSetupResult(
      results
        .map((r, i) =>
          r.status === "fulfilled" ? r.value.summary : `${ids[i]}: ${String(r.reason)}`,
        )
        .join("\n"),
    );
    void refreshHealth();
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
    () => restorableFrom(digests, stats, liveSessionIds),
    [digests, stats, liveSessionIds.join(",")],
  );

  // Bumped when the hook stream teaches us a binary (see observeForLearning),
  // which is the one thing that can change an identity without stats moving.
  const [learnedTick, setLearnedTick] = useState(0);

  const sessions = useMemo(() => {
    // Terminal -> the agent conversation running in it, by the surface id the
    // hook recorded from our spawn env. An exact identity, not a guess: two
    // claudes in the same directory are indistinguishable by cwd, and matching
    // on titles or newest-file-by-mtime attaches to the wrong one silently.
    // Newest wins if a terminal has hosted more than one session in its life.
    const bySurface = digestBySurface(digests, thisInstance);
    return stats.map((s) => {
      const digest = bySurface.get(String(s.id));
      return {
        session: s,
        // What this terminal is running, from the process the pty has in the
        // foreground — see agentIdentity.ts. `learnedTick` is in the dep list
        // because learning a binary changes this answer.
        agent: identifyAgent(s.agent_hint, digest),
        digest,
        // Where it's running — the thing that tells two `claude` rows apart.
        dir: (s.cwd || "").split("/").filter(Boolean).pop() ?? "",
      };
    });
  }, [stats, digests, thisInstance, learnedTick]);

  // The hook stream names binaries nothing else can identify, so a CLI Canopy
  // has never heard of is recognised from its second launch onward. Derived,
  // never asked.
  useEffect(() => {
    if (observeForLearning(sessions.map((s) => ({ hint: s.session.agent_hint, digest: s.digest }))))
      setLearnedTick((n) => n + 1);
  }, [sessions]);

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
  }, [noHookSignal, setupKey, setupResult]);

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

  const sessionRow = ({ session: s, agent, dir, digest }: (typeof sessions)[number]) => {
    const runaway =
      s.total_cpu > settings.runawayCpuPercent ||
      s.total_mem_bytes > settings.runawayMemBytes;
    // Lifecycle dot: only for agent rows the hook stream has spoken for, and
    // only believed as far as the session's own activity backs it up — a CLI
    // that stops without a Stop event leaves "working" behind forever.
    const shown = effectiveState({
      state: digest?.state,
      updated: digest?.updated,
      cpu: s.total_cpu,
      now: Date.now() / 1000,
    });
    const st = agent && shown ? STATE_META[shown] : undefined;
    const stTitle =
      shown === "stale"
        ? `No hook events for ${silenceLabel(digest?.updated, Date.now() / 1000)} and no CPU — this agent may have stopped without telling Canopy`
        : st?.label;
    // Only reclaim an agent that has finished — never one mid-turn or blocked.
    // `stale` is not finished: it is an agent we have lost track of, and
    // killing its terminal on a guess is not a trade worth making.
    const canHibernate =
      !!agent && (digest?.state === "idle" || digest?.state === "ended");
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
          {/* Which account it is spending. Two agents of the same CLI on the
              same branch are otherwise identical rows, and they can be drawing
              down two different subscriptions. Absent for the default account,
              which would put a badge on every row. */}
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

  const dismissBtn = (key: string) =>
    onDismissPending && (
      <Button icon className="pending-dismiss"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismissPending(key);
        }}>
        ✕
      </Button>
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
                            const inPanel = canAnswerInPanel(item);
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
                                className={`pending-option ${inPanel ? "pending-option-clickable" : ""} ${
                                  chosen ? "pending-option-chosen" : ""
                                }`}
                                title={inPanel ? "Select this option" : "Answer in the terminal"}
                                onClick={
                                  inPanel
                                    ? (e) => {
                                        e.stopPropagation();
                                        if (instantAnswer(item)) onAnswer!(item, [[oi]]);
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
                  {/* A single-page multi-select submits its picks as one
                      keystroke sequence (no page navigation to desync). A lone
                      single-select answered on click above, so it shows no
                      button. */}
                  {canAnswerInPanel(item) && !instantAnswer(item) && (
                    <Button variant="accent" className="pending-submit"
                      disabled={!answerable(item)}
                      title={
                        answerable(item)
                          ? "Send this answer to the terminal"
                          : "Choose an option first"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        submitAnswers(item);
                      }}>
                      Submit answer
                    </Button>
                  )}
                  {/* A multi-question form can't be answered reliably by
                      synthesised keystrokes (the pages desync into a decline),
                      so the panel sends you to the terminal to answer it there. */}
                  {onAnswer && multiPage(item) && (
                    <Button className="pending-submit"
                      title="Multi-question forms are answered in the terminal"
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToTerminal?.(item);
                      }}>
                      Answer in the terminal ↗
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <div className="pending-q-text">
                    <Mascot state="needs" size={16} className="pending-ash" />
                    {item.message}
                  </div>
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
              <div className="pending-q-text">
                <Mascot state="done" size={16} className="pending-ash" />
                {item.message}
              </div>
              <div className="pending-footer">
                <span className="event-time">{new Date(item.ts).toLocaleTimeString()}</span>
                <span className="pending-jump">open terminal ➜</span>
                {dismissBtn(item.key)}
              </div>
            </div>
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
          <Button icon
            title="How to hook up agent CLIs"
            onClick={() => setShowHookHelp((v) => !v)}>
            ?
          </Button>
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
          <Button variant="accent" onClick={() => void autoSetup(unhooked)}>
            Set up agent integrations
          </Button>
          {setupResult && <p className="hook-result">{setupResult}</p>}
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
          {/* One row per CLI with an auto-setup arm — every CLI whose
              integration surface supports it (see docs/agent-parity.md).
              SUPPORTED_AGENTS in agents.rs is the registry for these.
              Each row states what is actually on disk: a registration that
              silently failed used to be invisible here, which is how one
              survived unnoticed until a user asked why an agent was quiet. */}
          <div className="hook-setup-list">
            {AGENT_LABELS.map((a) => {
              const h = health.find((x) => x.agent === a.id);
              return (
                <div key={a.id} className="hook-setup-row">
                  <span className="hook-setup-name">{a.label}</span>
                  {h && !h.cli_installed && (
                    <span className="hook-setup-state" title="This CLI isn't on your PATH">
                      not installed
                    </span>
                  )}
                  {h?.cli_installed && (
                    <>
                      <span
                        className={`hook-setup-state ${HEALTH_TONE[h.hooks] ?? ""}`}
                        title={HEALTH_HELP.hooks[h.hooks] ?? h.hooks}
                      >
                        hooks {h.hooks}
                      </span>
                      <span
                        className={`hook-setup-state ${HEALTH_TONE[h.mcp] ?? ""}`}
                        title={HEALTH_HELP.mcp[h.mcp] ?? h.mcp}
                      >
                        MCP {h.mcp}
                      </span>
                    </>
                  )}
                  <Button variant="accent" onClick={() => void autoSetup(a.id)}>
                    Set up
                  </Button>
                </div>
              );
            })}
          </div>
          {setupResult && <p className="hook-result">{setupResult}</p>}
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
          if it is visible — and if a dead session's claim can be dropped. */}
      {claims.length > 0 && (
        <Section title="Claimed files" count={claims.length} tone="quiet">
          <div className="claim-list">
            {claims.map((claim) => (
              <div key={claim.owner} className="claim-row">
                <span className="claim-owner" title={claim.owner}>
                  {claim.owner.split(" (")[0]}
                </span>
                <span className="claim-paths" title={claim.paths.join("\n")}>
                  {claim.note ? `${claim.note} — ` : ""}
                  {claim.paths.map((p) => p.split("/").pop()).join(", ")}
                </span>
                <Button
                  title="Drop this claim — for an agent that died holding it"
                  onClick={() => {
                    void ipc.contextReleaseClaim(claim.owner).catch(() => {});
                  }}>
                  Release
                </Button>
              </div>
            ))}
          </div>
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
            const dir = runIn.split("/").filter(Boolean).pop() ?? "";
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
                    onClick={() => {
                      // The row stands for its whole directory (see
                      // newestPerDirectory), so forgetting only the session on
                      // show would just promote the next one behind it.
                      const gone = [d, ...superseded];
                      // Tombstone first: sessions read from a CLI's own on-disk
                      // store (omp) aren't in ~/.canopy/sessions, so deleting
                      // that file can't stop them — the next poll re-reads them
                      // from omp's dir and they come straight back. The
                      // persistent forget is what restorableFrom actually
                      // filters on, so it's the only thing that makes an omp
                      // session stay gone.
                      forgetSessions(gone);
                      for (const g of gone) {
                        void ipc.sessionForget(g.session_id).catch(() => {});
                      }
                      const ids = new Set(gone.map((g) => g.session_id));
                      setDigests((prev) => prev.filter((x) => !ids.has(x.session_id)));
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

import { fixedNumber } from "../format";
import { hasCommandModifier } from "../shortcuts";
// Agent management: one row per terminal session, named after whatever the pty
// has in its foreground (see agentIdentity.ts), with CPU/memory for the runaway
// guard.
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { markRestored } from "../restorable";
import { SETTLED_TTL_MS, type SettledSession } from "../settledSessions";
import { openSessionDoc } from "../sessionDoc/events";
import { SubagentTree } from "./SubagentTree";
import { lastHumanPrompt, useAgentSessions } from "../agentSessions";
import { claimOwnerName } from "../claims";
import { AGENT_LABELS, IntegrationsList, useIntegrations } from "./AgentIntegrations";
import { PendingCard } from "./PendingCard";
import { AgentRuntime } from "./AgentRuntime";
import {
  AgentIcon,
  DiffIcon,
  DocumentIcon,
  MoonIcon,
  RestartIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";
import { useEscape } from "../useEscape";
import type { PendingItem } from "../notifications";
import { Button } from "./ui";
import { ReceiptBadge } from "./ReceiptBadge";
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
  "Agents see each other's recent prompts and files.";

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
  /** Agents put away with Settle in this project, newest first. */
  settled?: SettledSession[];
  onRestoreSettled?: (entry: SettledSession) => void;
  /** Remove a settled agent's worktree, branch and record now. */
  onDiscardSettled?: (entry: SettledSession) => void;
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
const meshEnd = (
  pty: number | null | undefined,
  name?: string | null,
  agent?: string | null,
) =>
  pty == null ? "companion" : name || (agent ? `${agent} ${pty}` : `terminal ${pty}`);

/** Compact relative age; the panel is narrow and "3h" beats a timestamp. */
/** "5m", "2h", "3d": the compact age a thread list shows beside a name. */
export const agoShort = (secs?: number) => {
  if (!secs) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
};

/** Which component an agent works in: the deepest configured root holding its
 *  directory, named by that root's folder. Anything outside every root is
 *  grouped by its own folder name. */
export function componentGroup(cwd: string, roots: string[]): string {
  const root = roots
    .filter((r) => cwd === r || cwd.startsWith(r.replace(/\/+$/, "") + "/"))
    .sort((a, b) => b.length - a.length)[0];
  return basename(root ?? cwd) || cwd;
}

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
        <div className="modal-body">
        <p className="share-modal-note">{SHARE_EXPLAIN}</p>
        {shared.length === 0 ? (
          <p className="share-none">Nothing yet.</p>
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
        </div>
        <div className="modal-actions">
          <Button onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
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
  settled = [],
  onRestoreSettled,
  onDiscardSettled,
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


  // ---- The list -------------------------------------------------------------
  // One flat list the keyboard walks: waiting-on-you first, then running agents
  // by project, terminals, claims, and what can be restored. The mouse is a
  // bonus, never the only way: every action below has a key (see KEYS).
  type Row = (typeof sessions)[number];
  type Restorable = (typeof restorable)[number];
  type Item =
    | { key: string; kind: "agent" | "term"; row: Row }
    | { key: string; kind: "claim"; claim: ipc.AgentClaim }
    | { key: string; kind: "restore"; entry: Restorable }
    | { key: string; kind: "settled"; entry: SettledSession }
    | { key: string; kind: "more" };

  const uid = useId().replace(/:/g, "");
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [showAllRestorable, setShowAllRestorable] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  // A destructive key press is armed by the first press and done by the second.
  const [armed, setArmed] = useState<string | null>(null);
  const lastIndex = useRef(0);

  // Bring the filter under the cursor when the panel is opened (a tab switch is
  // the person asking for it), never on first paint of an already-open panel.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) filterRef.current?.focus();
    wasVisible.current = visible;
  }, [visible]);

  const query = filter.trim().toLowerCase();
  const matches = (...parts: (string | null | undefined)[]) =>
    query === "" || parts.filter(Boolean).join(" ").toLowerCase().includes(query);

  const nameOf = (row: Row) =>
    agentDisplayName({
      tab: tabNames?.get(row.session.id),
      sessionName: row.session.name,
      sessionTitle: row.session.title,
      cwd: row.session.cwd,
      agentLabel: row.agent?.label,
    });

  const rowMatches = (row: Row) =>
    matches(
      nameOf(row),
      row.agent?.label,
      row.dir,
      row.digest?.branch,
      row.digest?.profile,
      lastHumanPrompt(row.digest?.prompts),
      row.session.cwd,
    );

  const blocks = useMemo(() => {
    const out: { title: string; tone?: "urgent"; groups: { name: string | null; items: Item[] }[] }[] = [];
    const visibleAgents = agentSessions.filter(rowMatches);
    const waiting = visibleAgents.filter(
      (row) => bucketFor(lifeOf(row), attentionOf(row.session.id)) === "attention",
    );
    const running = visibleAgents.filter((row) => !waiting.includes(row));
    if (waiting.length > 0)
      out.push({
        title: "Waiting on you",
        tone: "urgent",
        groups: [{ name: null, items: waiting.map((row) => ({ key: `a:${row.session.id}`, kind: "agent", row })) }],
      });
    if (running.length > 0) {
      const byGroup = new Map<string, Item[]>();
      for (const row of running) {
        const name = componentGroup(row.session.cwd, roots);
        byGroup.set(name, [...(byGroup.get(name) ?? []), { key: `a:${row.session.id}`, kind: "agent", row }]);
      }
      out.push({
        title: "Running",
        groups: [...byGroup].map(([name, items]) => ({ name: byGroup.size > 1 ? name : null, items })),
      });
    }
    const terms = termSessions.filter(rowMatches);
    if (terms.length > 0)
      out.push({
        title: "Terminals",
        groups: [{ name: null, items: terms.map((row) => ({ key: `t:${row.session.id}`, kind: "term", row })) }],
      });
    const claimItems: Item[] = claims
      .filter((claim) => matches(claim.owner, claim.note, claim.paths.join(" ")))
      .map((claim) => ({ key: `c:${claim.id}`, kind: "claim", claim }));
    if (claimItems.length > 0) out.push({ title: "Claimed files", groups: [{ name: null, items: claimItems }] });
    const settledItems: Item[] = settled
      .filter((entry) => matches(entry.title, entry.agentId, basename(entry.cwd), entry.branch))
      .map((entry) => ({ key: `s:${entry.id}`, kind: "settled", entry }));
    if (settledItems.length > 0) out.push({ title: "Settled", groups: [{ name: null, items: settledItems }] });
    const settledIds = new Set(settled.map((entry) => entry.id));
    const past = [...restorable]
      .filter((entry) => !settledIds.has(entry.digest.session_id))
      .sort((a, b) => (b.digest.updated ?? 0) - (a.digest.updated ?? 0))
      .filter((entry) =>
        matches(entry.agentId, basename(entry.cwd), entry.digest.branch, lastHumanPrompt(entry.digest.prompts)),
      );
    if (past.length > 0) {
      // The recent few; a filter or "show all" lifts the cap.
      const cap = query !== "" || showAllRestorable ? past.length : 5;
      const items: Item[] = past
        .slice(0, cap)
        .map((entry) => ({ key: `r:${entry.digest.session_id}`, kind: "restore", entry }));
      if (past.length > 5 && query === "") items.push({ key: "more", kind: "more" });
      out.push({ title: "Restorable", groups: [{ name: null, items }] });
    }
    return out;
    // `rowMatches` and `matches` close over `query` and the props already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSessions, termSessions, claims, restorable, settled, query, showAllRestorable, roots, tabNames, lifeOf, attentionOf]);

  const items = useMemo(() => blocks.flatMap((b) => b.groups.flatMap((g) => g.items)), [blocks]);
  const found = items.findIndex((item) => item.key === cursorKey);
  const cursorIndex = items.length === 0 ? -1 : found >= 0 ? found : Math.min(lastIndex.current, items.length - 1);
  const cursorItem = cursorIndex >= 0 ? items[cursorIndex] : undefined;
  lastIndex.current = Math.max(0, cursorIndex);
  const domId = (key: string) => `ap2-${uid}-${key.replace(/[^a-z0-9]/gi, "_")}`;

  useEffect(() => {
    if (!cursorItem) return;
    document.getElementById(domId(cursorItem.key))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorItem?.key]);

  const move = (delta: number | "first" | "last") => {
    if (items.length === 0) return;
    const next =
      delta === "first" ? 0 : delta === "last" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, cursorIndex + delta));
    setCursorKey(items[next].key);
    setArmed(null);
  };

  const restoreEntry = (entry: Restorable) => {
    // Bridge the gap until the resumed agent's first hook event rewrites the
    // digest's surface; without it the row sits looking un-restored.
    markRestored(entry.digest.session_id);
    onRestore?.(entry.cwd, entry.command, entry.agentId, entry.agentId);
  };
  const documentEntry = (entry: Restorable) =>
    openSessionDoc({
      kind: "session",
      sessionId: entry.digest.session_id,
      agent: entry.agentId,
      cwd: entry.cwd,
      digest: entry.digest,
      resumeCommand: entry.command,
      onResume: () => restoreEntry(entry),
    });

  const activate = (item: Item) => {
    if (item.kind === "agent" || item.kind === "term") onJumpToPty?.(item.row.session.id);
    else if (item.kind === "restore") restoreEntry(item.entry);
    else if (item.kind === "settled") onRestoreSettled?.(item.entry);
    else if (item.kind === "claim") onOpenClaim?.(item.claim);
    else setShowAllRestorable((v) => !v);
  };

  const canHibernateRow = (row: Row) =>
    !!row.agent && reclaimable(lifeOf(row), attentionOf(row.session.id));

  const remove = (item: Item) => {
    if (item.kind === "agent" || item.kind === "term") void ipc.ptyKill(item.row.session.id);
    else if (item.kind === "restore") forget([item.entry.digest, ...item.entry.superseded]);
    else if (item.kind === "settled") onDiscardSettled?.(item.entry);
    else if (item.kind === "claim")
      void ipc
        .contextReleaseClaim(item.claim.owner_key)
        .catch((err) => onNotice?.(`Couldn't release this claim: ${err}`));
  };

  // Disarm on its own, so a stray first press cannot sit there for an hour.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || hasCommandModifier(e)) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "j":
      case "ArrowDown":
        handled();
        return move(1);
      case "k":
      case "ArrowUp":
        handled();
        return move(-1);
      case "g":
      case "Home":
        handled();
        return move("first");
      case "G":
      case "End":
        handled();
        return move("last");
      case "Enter":
      case " ":
        if (cursorItem) {
          handled();
          activate(cursorItem);
        }
        return;
      case "/":
        handled();
        filterRef.current?.focus();
        return;
      case "o":
        if (cursorItem && (cursorItem.kind === "agent") && cursorItem.row.agent?.id && onOpenAgent) {
          handled();
          const { session: s, agent, digest } = cursorItem.row;
          onOpenAgent({ agent: agent!.id ?? "agent", cwd: s.cwd, ptyId: s.id, sessionId: digest?.session_id, digest });
        }
        return;
      case "h":
        if (cursorItem?.kind === "agent" && canHibernateRow(cursorItem.row)) {
          handled();
          hibernate(cursorItem.row.session.id);
        }
        return;
      case "d":
        if (cursorItem?.kind === "restore") {
          handled();
          documentEntry(cursorItem.entry);
        }
        return;
      case "x":
      case "Delete":
      case "Backspace":
        if (cursorItem && cursorItem.kind !== "more") {
          handled();
          if (armed === cursorItem.key) {
            setArmed(null);
            remove(cursorItem);
          } else {
            setArmed(cursorItem.key);
          }
        }
        return;
      case "a":
        handled();
        setShowAllRestorable((v) => !v);
        return;
      case "s":
        handled();
        onShareContext(!shareContext);
        return;
      case "i":
        handled();
        onOpenInstructions?.();
        return;
      case "w":
        if (onOpenAgentsPage) {
          handled();
          onOpenAgentsPage();
        }
        return;
      case "t":
        handled();
        setShowHookHelp((v) => !v);
        return;
      case "?":
        handled();
        setShowKeys((v) => !v);
        return;
    }
  };

  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (hasCommandModifier(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      listRef.current?.focus();
      move(e.key === "ArrowDown" ? (cursorIndex < 0 ? "first" : 1) : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursorItem) activate(cursorItem);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setFilter("");
      listRef.current?.focus();
    }
  };

  // ---- Rows -----------------------------------------------------------------
  const portChips = (row: Row) =>
    row.session.ports?.map((p) => (
      <button
        key={p}
        type="button"
        tabIndex={-1}
        className="ap2-chip ap2-chip-port"
        title={
          onPreviewUrl
            ? `Preview http://localhost:${p} in Canopy — ${format("open-external")}-click for your browser`
            : `Open http://localhost:${p} in your browser`
        }
        onClick={(e) => {
          e.stopPropagation();
          if (onPreviewUrl && !matchesModifierClick(e, "open-external")) {
            onPreviewUrl(`http://localhost:${p}`);
          } else {
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(`http://localhost:${p}`));
          }
        }}
      >
        :{p}
      </button>
    ));

  const sessionRow = (item: Extract<Item, { kind: "agent" | "term" }>) => {
    const { session: s, agent, dir, digest } = item.row;
    const row = item.row;
    const selected = cursorItem?.key === item.key;
    const runaway =
      s.total_cpu > settings.runawayCpuPercent || s.total_mem_bytes > settings.runawayMemBytes;
    // Only believed as far as the session's own activity backs it up.
    const life = lifeOf(row);
    const shown = life.state;
    const meta = agent ? LIFE_META[shown] : undefined;
    const stTitle =
      shown === "unknown"
        ? `${life.note} (silent for ${silenceLabel(digest?.updated, Date.now() / 1000)})`
        : life.note || meta?.label;
    const task = lastHumanPrompt(digest?.prompts);
    const name = nameOf(row);
    const needsYou = bucketFor(life, attentionOf(s.id)) === "attention";
    const canHibernate = canHibernateRow(row);
    const trail = armed === item.key
      ? "press x again to close"
      : !agent
        ? ""
        : shown === "working"
          ? "Working"
          : shown === "waiting"
            ? "Needs you"
            : agoShort(digest?.updated);
    return (
      <div
        key={item.key}
        id={domId(item.key)}
        role="option"
        aria-selected={selected}
        className={`ap2-row ${selected ? "is-cursor" : ""} ${s.id === activePty ? "is-active" : ""} ${runaway ? "is-runaway" : ""}`}
        onClick={() => {
          setCursorKey(item.key);
          onJumpToPty?.(s.id);
        }}
        title={[
          name,
          agent && name !== agent.label ? `${agent.label} (identified by ${agent.via})` : agent ? `identified by ${agent.via}` : undefined,
          s.cwd,
          digest?.branch,
          task,
          `${fixedNumber(s.total_cpu, 0)}% cpu · ${fmtMem(s.total_mem_bytes)} · ${s.procs.length} procs`,
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <div className="ap2-line">
          <span className={`ap2-dot ap2-dot-${agent ? shown : "none"}`} title={stTitle} aria-hidden="true" />
          {agent?.id ? <AgentIcon id={agent.id} size={13} className="ap2-mark" /> : <TerminalIcon size={12} className="ap2-mark" />}
          <span className="ap2-name">{name}</span>
          {runaway && <span className="runaway-badge">runaway?</span>}
          {needsYou && (
            <span className="ap2-badge" title="This agent is waiting for your answer">
              needs you
            </span>
          )}
          <span className="ap2-spacer" />
          <span className={`ap2-trail ap2-trail-${agent ? shown : "none"} ${armed === item.key ? "is-armed" : ""}`} title={stTitle}>
            {trail}
          </span>
        </div>
        <div className="ap2-meta">
          {agent && <AgentRuntime timing={digest} live={shown === "working"} />}
          {agent && (shown === "idle" || shown === "ended") && (
            <ReceiptBadge sessionId={digest?.session_id} ptyId={s.id} cwd={s.cwd} cli={agent.id ?? ""} quietWhenUnverified={shown === "ended"} />
          )}
          {dir && <span className="ap2-chip" title={s.cwd}>{dir}</span>}
          {digest?.branch && <span className="ap2-chip ap2-chip-branch" title={`On branch ${digest.branch}`}>⎇ {digest.branch}</span>}
          {digest?.profile && digest.profile !== "default" && (
            <span className="ap2-chip" title={`Running under the "${digest.profile}" account`}>{digest.profile}</span>
          )}
          {(digest?.subagents ?? 0) > 0 && (
            <span className="ap2-chip" title={`${digest?.subagents} subagent${digest?.subagents === 1 ? "" : "s"} finished this turn`}>⑃ {digest?.subagents}</span>
          )}
          {portChips(row)}
        </div>
        {task && <div className="ap2-prompt">{task}</div>}
        {agent?.id && digest?.session_id && (
          <SubagentTree
            compact
            live={shown === "working"}
            activityKey={{ agent: agent.id, sessionId: digest.session_id, cwd: s.cwd, profile: digest.profile ?? null }}
          />
        )}
        {selected && (
          <div className="ap2-stats">
            {fixedNumber(s.total_cpu, 0)}% cpu · {fmtMem(s.total_mem_bytes)} · {s.procs.length} procs
          </div>
        )}
        <div className="ap2-actions">
          {agent?.id && onOpenAgent && (
            <button
              type="button"
              tabIndex={-1}
              className="ap2-act"
              title="Open this agent's workspace — files, diffs, commits and PR"
              onClick={(e) => {
                e.stopPropagation();
                onOpenAgent({ agent: agent.id ?? "agent", cwd: s.cwd, ptyId: s.id, sessionId: digest?.session_id, digest });
              }}
            >
              <DiffIcon size={12} />
            </button>
          )}
          {canHibernate && (
            <button
              type="button"
              tabIndex={-1}
              className="ap2-act"
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
            type="button"
            tabIndex={-1}
            className="ap2-act ap2-act-danger"
            title={`Kill terminal #${s.id}${agent ? ` and the ${agent.label} running in it` : ""}`}
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

  const settledRow = (item: Extract<Item, { kind: "settled" }>) => {
    const { entry } = item;
    const selected = cursorItem?.key === item.key;
    const dir = basename(entry.worktree?.root ?? entry.cwd);
    const leftMs = entry.settledAt + SETTLED_TTL_MS - Date.now();
    const unsaved = entry.unsaved
      ? [
          entry.unsaved.dirty > 0 && `${entry.unsaved.dirty} uncommitted`,
          entry.unsaved.unpushed > 0 && `${entry.unsaved.unpushed} unpushed`,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    const fate = entry.unsaved?.note
      ? `Kept: ${entry.unsaved.note}${unsaved ? `, ${unsaved}` : ""}`
      : unsaved
      ? `Kept: ${unsaved}`
      : entry.worktree
        ? `Cleans up in ${Math.max(1, Math.ceil(leftMs / 3_600_000))}h`
        : "";
    return (
      <div
        key={item.key}
        id={domId(item.key)}
        role="option"
        aria-selected={selected}
        className={`ap2-row ap2-row-past ${selected ? "is-cursor" : ""}`}
        onClick={() => setCursorKey(item.key)}
        onDoubleClick={() => onRestoreSettled?.(entry)}
        title={`${entry.title}\n${entry.cwd}`}
      >
        <div className="ap2-line">
          <span className="ap2-dot ap2-dot-ended" aria-hidden="true" />
          <AgentIcon id={entry.agentId} size={13} className="ap2-mark" />
          <span className="ap2-name">{entry.title}</span>
          <span className="ap2-spacer" />
          <span className={`ap2-trail ${armed === item.key ? "is-armed" : ""}`}>
            {armed === item.key
              ? "press x again to discard"
              : agoShort(Math.floor(entry.settledAt / 1000))}
          </span>
        </div>
        <div className="ap2-meta">
          {dir && <span className="ap2-chip" title={entry.cwd}>{dir}</span>}
          {entry.branch && <span className="ap2-chip ap2-chip-branch">⎇ {entry.branch}</span>}
          {fate && (
            <span className={`ap2-chip${entry.unsaved ? " ap2-chip-warn" : ""}`}>{fate}</span>
          )}
        </div>
        <div className="ap2-actions">
          <button
            type="button"
            tabIndex={-1}
            className="ap2-act"
            title="Restore: reopen this agent and its conversation"
            aria-label={`Restore ${entry.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onRestoreSettled?.(entry);
            }}
          >
            <RestartIcon size={12} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="ap2-act ap2-act-danger"
            title={
              unsaved
                ? `Discard: deletes its worktree with ${unsaved}`
                : "Discard: remove its worktree and record now"
            }
            aria-label={`Discard ${entry.title}`}
            onClick={(e) => {
              e.stopPropagation();
              if (armed === item.key) {
                setArmed(null);
                onDiscardSettled?.(entry);
              } else {
                setArmed(item.key);
                setCursorKey(item.key);
              }
            }}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      </div>
    );
  };

  const restoreRow = (item: Extract<Item, { kind: "restore" }>) => {
    const { digest: d, agentId, cwd: runIn, command: cmd, superseded } = item.entry;
    const selected = cursorItem?.key === item.key;
    // runIn is resume_cwd, not cwd: claude looks the conversation up under its
    // project root, so resuming from a subdirectory reports "No conversation".
    const dir = basename(runIn);
    const last = lastHumanPrompt(d.prompts);
    return (
      <div
        key={item.key}
        id={domId(item.key)}
        role="option"
        aria-selected={selected}
        className={`ap2-row ap2-row-past ${selected ? "is-cursor" : ""}`}
        onClick={() => setCursorKey(item.key)}
        onDoubleClick={() => restoreEntry(item.entry)}
        title={`${agentId}\n${runIn}\n${last ?? ""}`.trim()}
      >
        <div className="ap2-line">
          <span className="ap2-dot ap2-dot-ended" aria-hidden="true" />
          <AgentIcon id={agentId} size={13} className="ap2-mark" />
          <span className="ap2-name">{agentId}</span>
          <span className="ap2-spacer" />
          <span className={`ap2-trail ${armed === item.key ? "is-armed" : ""}`}>
            {armed === item.key ? "press x again to forget" : agoShort(d.updated)}
          </span>
        </div>
        <div className="ap2-meta">
          <AgentRuntime timing={d} live={false} />
          {dir && <span className="ap2-chip" title={runIn}>{dir}</span>}
          {d.branch && <span className="ap2-chip ap2-chip-branch">⎇ {d.branch}</span>}
        </div>
        <div className="ap2-prompt">{last ?? <em>(no prompt captured for this session)</em>}</div>
        <div className="ap2-actions">
          <button
            type="button"
            tabIndex={-1}
            className="ap2-act"
            title={`Restore this session — ${cmd}`}
            onClick={(e) => {
              e.stopPropagation();
              restoreEntry(item.entry);
            }}
          >
            <RestartIcon size={12} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="ap2-act"
            title="Read this session as a document and hand it off"
            onClick={(e) => {
              e.stopPropagation();
              documentEntry(item.entry);
            }}
          >
            <DocumentIcon size={12} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="ap2-act ap2-act-danger"
            title={
              superseded.length > 0
                ? `Forget this directory's ${superseded.length + 1} sessions — removes them from this list`
                : "Forget this session — removes it from this list"
            }
            // The row stands for its whole directory, so forgetting only the
            // session on show would just promote the next one behind it.
            onClick={(e) => {
              e.stopPropagation();
              forget([d, ...superseded]);
            }}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      </div>
    );
  };

  const claimRow = (item: Extract<Item, { kind: "claim" }>) => {
    const { claim } = item;
    const selected = cursorItem?.key === item.key;
    return (
      <div
        key={item.key}
        id={domId(item.key)}
        role="option"
        aria-selected={selected}
        className={`ap2-row ap2-row-claim ${selected ? "is-cursor" : ""}`}
        title={`${claim.owner}\n${claim.paths.join("\n")}${onOpenClaim ? "\nEnter opens this claim" : ""}`}
        onClick={() => {
          setCursorKey(item.key);
          onOpenClaim?.(claim);
        }}
      >
        <div className="ap2-line">
          <span className="ap2-name">{claimOwnerName(claim.owner)}</span>
          {/* A contested file is the most useful thing this list can say. */}
          {claim.refusals.length > 0 && (
            <span
              className="ap2-badge"
              title={`${claim.refusals.length} other claim${claim.refusals.length === 1 ? "" : "s"} on these files ${
                claim.refusals.length === 1 ? "was" : "were"
              } turned away — open the claim to see who`}
            >
              ⛔ {claim.refusals.length}
            </span>
          )}
          <span className="ap2-spacer" />
          <span className={`ap2-trail ${armed === item.key ? "is-armed" : ""}`}>{armed === item.key ? "press x again to release" : ""}</span>
        </div>
        <div className="ap2-prompt">
          {claim.note ? `${claim.note} — ` : ""}
          {claim.paths.map((p) => basename(p)).join(", ")}
        </div>
        <div className="ap2-actions">
          <button
            type="button"
            tabIndex={-1}
            className="ap2-act ap2-act-text"
            title="Drop this claim — for an agent that died holding it"
            onClick={(e) => {
              e.stopPropagation();
              // A release that failed and said nothing looks exactly like a
              // claim that won't die.
              void ipc.contextReleaseClaim(claim.owner_key).catch((err) => onNotice?.(`Couldn't release this claim: ${err}`));
            }}
          >
            Release
          </button>
        </div>
      </div>
    );
  };

  const renderItem = (item: Item) => {
    if (item.kind === "agent" || item.kind === "term") return sessionRow(item);
    if (item.kind === "restore") return restoreRow(item);
    if (item.kind === "settled") return settledRow(item);
    if (item.kind === "claim") return claimRow(item);
    const past = restorable.length;
    return (
      <div
        key={item.key}
        id={domId(item.key)}
        role="option"
        aria-selected={cursorItem?.key === item.key}
        className={`ap2-row ap2-more ${cursorItem?.key === item.key ? "is-cursor" : ""}`}
        onClick={() => {
          setCursorKey(item.key);
          setShowAllRestorable((v) => !v);
        }}
      >
        {showAllRestorable ? "Show fewer" : `Show all ${past}`} <kbd>a</kbd>
      </div>
    );
  };

  // Blocked-on-you vs merely-finished: the same stream, very different urgency.
  const urgent = pending.filter((i) => i.kind !== "idle");
  const idle = pending.filter((i) => i.kind === "idle");
  const keyHints: [string, string][] = [
    ["j k  ↑ ↓", "move"],
    ["Enter", "jump to terminal · restore"],
    ["/", "filter (Esc leaves it)"],
    ["o", "open the agent's workspace"],
    ["h", "hibernate an idle agent"],
    ["x", "close · forget · release (twice)"],
    ["d", "read a past session as a document"],
    ["a", "show all restorable"],
    ["s", "toggle shared context"],
    ["i", "agent instructions"],
    ["w", "agents page"],
    ["t", "hook setup help"],
  ];

  return (
    <div className="side-panel ap2" aria-label="Agents">
      <div className="ap2-filter">
        <input
          ref={filterRef}
          className="ap2-filter-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="Filter agents…"
          aria-label="Filter agents"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKey}
        />
        <button
          type="button"
          className="ap2-keys-toggle"
          aria-pressed={showKeys}
          title="Keyboard shortcuts (?)"
          onClick={() => setShowKeys((v) => !v)}
        >
          ?
        </button>
      </div>
      {showKeys && (
        <dl className="ap2-keys" aria-label="Keyboard shortcuts">
          {keyHints.map(([k, d]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      )}

      {urgent.length > 0 && (
        <>
          <div className="ap2-head ap2-head-urgent">
            <span>Needs your input</span>
            <span className="ap2-count">{urgent.length}</span>
          </div>
          {urgent.map((item) => (
            <PendingCard key={item.key} item={item} onAnswer={onAnswer} onRespond={onRespond} onJumpToTerminal={onJumpToTerminal} onDismiss={onDismissPending} />
          ))}
        </>
      )}
      {idle.length > 0 && (
        <>
          <div className="ap2-head">
            <span>Finished</span>
            <span className="ap2-count">{idle.length}</span>
          </div>
          {idle.map((item) => (
            <PendingCard key={item.key} item={item} onJumpToTerminal={onJumpToTerminal} onDismiss={onDismissPending} />
          ))}
        </>
      )}

      {/* Hooks genuinely absent — offer the one-click setup. */}
      {noHookSignal && !showHookHelp && unhooked !== null && unhooked.length > 0 && (
        <div className="hook-nudge">
          <span>
            No events are streaming in from{" "}
            {unhooked.map((id) => AGENT_LABELS.find((a) => a.id === id)?.label ?? id).join(", ")} — questions, tasks and tokens won't show until hooks are set up.
          </span>
          <Button variant="accent" onClick={() => void integrations.setUp(unhooked)}>
            Set up agent integrations
          </Button>
          {integrations.result && <p className="hook-result">{integrations.result}</p>}
        </div>
      )}
      {/* Hooks are installed; these agents just predate them. */}
      {noHookSignal && !showHookHelp && unhooked?.length === 0 && !hintDismissed && (
        <div className="hook-nudge">
          <span>Hooks are set up, but these agents started before that — restart one to stream its questions, tasks and tokens here.</span>
          <Button onClick={dismissHint}>Got it</Button>
        </div>
      )}
      {showHookHelp && hookPath && (
        <div className="hook-help">
          <IntegrationsList health={integrations.health} onSetUp={(a) => void integrations.setUp(a)} />
          {integrations.result && <p className="hook-result">{integrations.result}</p>}
          <p>Other CLIs:</p>
          <code className="hook-path">{hookPath}</code>
        </div>
      )}

      <div
        ref={listRef}
        className="ap2-list"
        role="listbox"
        aria-label="Agents and sessions"
        tabIndex={0}
        aria-activedescendant={cursorItem ? domId(cursorItem.key) : undefined}
        onKeyDown={onListKey}
      >
        {blocks.map((block) => (
          <div key={block.title} role="group" aria-label={block.title} className="ap2-block">
            <div className={`ap2-head ${block.tone === "urgent" ? "ap2-head-urgent" : ""}`}>
              <span>{block.title}</span>
              <span className="ap2-count">{block.groups.reduce((n, g) => n + g.items.filter((i) => i.kind !== "more").length, 0)}</span>
            </div>
            {block.groups.map((group) => (
              <div key={group.name ?? "-"}>
                {group.name && <div className="ap2-sub">{group.name}</div>}
                {group.items.map(renderItem)}
              </div>
            ))}
          </div>
        ))}
        {items.length === 0 && (
          <div className="ap2-empty">
            {query !== "" ? `Nothing matches “${filter.trim()}”.` : "No agents. Start one from ＋."}
          </div>
        )}
      </div>

      {/* Messages agents have typed into each other (canopy_message_agent). One
          arrives in its target's composer indistinguishable from the user typing,
          so this log is the only place the reach-in is recoverable. */}
      {messages.length > 0 && (
        <div className="ap2-block ap2-quiet">
          <div className="ap2-head">
            <span>Agent messages</span>
            <span className="ap2-count">{messages.length}</span>
          </div>
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
                    {meshEnd(m.from_pty_id, m.from_name, m.from_agent)}
                    {" → "}
                    {meshEnd(m.to_pty_id, m.to_name, m.to_agent)}
                  </span>
                  <span className="mesh-msg-text">{m.text}</span>
                  {!m.submitted && (
                    <span className="mesh-msg-flag" title="May still be unsent in its composer.">
                      unsent
                    </span>
                  )}
                  <span className="mesh-msg-when">{ago(m.at_ms / 1000)}</span>
                </div>
              ))}
          </div>
          {messages.length > MESH_TOP_N && (
            <button className="research-more" onClick={() => setShowAllMessages((v) => !v)}>
              {showAllMessages ? "Show recent only" : `View all ${messages.length} messages`}
            </button>
          )}
        </div>
      )}

      {/* Instructions and shared context: one quiet row, both a key away. */}
      <div className="ap2-foot">
        <button
          type="button"
          className="ap2-foot-btn"
          title={
            instructionsFailed
              ? "Couldn't look for instruction files"
              : "Open all agent instructions — CLAUDE.md, AGENTS.md, skills, subagents (i)"
          }
          onClick={() => onOpenInstructions?.()}
        >
          Instructions
          {headlineInstructions.live > 0 && <span className="ap2-count">{headlineInstructions.live}</span>}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={shareContext}
          className="ap2-foot-btn"
          title={`${SHARE_EXPLAIN} (s)`}
          onClick={() => onShareContext(!shareContext)}
        >
          Shared context <span className={shareContext ? "ap2-on" : "ap2-off"}>{shareContext ? "on" : "off"}</span>
        </button>
        {shareContext && (
          <button type="button" className="share-peek" title="See exactly what the other sessions are being told" onClick={() => setShowShared(true)}>
            {shared.length} shared
          </button>
        )}
        <span className="ap2-spacer" />
        {onOpenAgentsPage && (
          <button type="button" className="ap2-foot-btn" title="Open the agents page — every session, with room to read it (w)" onClick={onOpenAgentsPage}>
            ⤢
          </button>
        )}
        <button type="button" className="ap2-foot-btn" title="How to hook up agent CLIs (t)" onClick={() => setShowHookHelp((v) => !v)}>
          hooks
        </button>
      </div>
      {showShared && <SharedDialog shared={shared} onClose={() => setShowShared(false)} />}
    </div>
  );
}

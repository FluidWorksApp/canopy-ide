// Agent management, as a page rather than a column.
//
// The side panel is 300px of stacked lists: it answers "is anything waiting on
// me right now" at a glance, and everything else it shows — what each session
// is working on, what it has spent, what can be brought back — is truncated to
// one line or folded away. This is the same material given room: a card per
// running agent with its task and its numbers legible, and the archive of past
// sessions as a list you can actually search.
//
// It is the panel's contents, not a second version of them: sessions, restore
// and integrations all come from the shared hooks, so the two surfaces cannot
// disagree about what is running. What the page adds is space, sorting (blocked
// agents first — the whole point of looking) and per-session spend.
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { basename } from "../paths";
import { getSettings } from "../settings";
import { agentDisplayName, type TabName } from "../agentDisplayName";
import { LIFE_META, NO_ATTENTION, bucketFor, reclaimable, silenceLabel } from "../../shared/agentLife";
import type { LifeState } from "../../shared/agentLife";
import { ashFor } from "../ash";
import { markRestored } from "../restorable";
import { lastHumanPrompt, useAgentSessions, type SessionRow } from "../agentSessions";
import { claimOwnerName } from "../claims";
import { IntegrationsList, useIntegrations } from "./AgentIntegrations";
import { PendingCard } from "./PendingCard";
import { Mascot } from "./Mascot";
import { AgentRuntime } from "./AgentRuntime";
import { sessionCost } from "../pricing";
import { fmtTokens } from "../format";
import {
  AgentIcon,
  DiffIcon,
  DocumentIcon,
  ExchangeIcon,
  MoonIcon,
  RestartIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";
import type { PendingItem } from "../notifications";
import { Button, Switch, TextInput } from "./ui";

const fmtMem = (bytes: number) =>
  bytes > 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;

const fmtCost = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/** Compact relative age; a card has room for "4h ago", not a timestamp. */
const ago = (secs?: number) => {
  if (!secs) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

/** Blocked agents first, then the ones actually working, then everything that
 *  has stopped saying anything — the order you'd walk the room in. Ties break
 *  on how recently the session spoke, so a card never swaps places with its
 *  neighbour on an unrelated poll. */
const RANK: Record<LifeState, number> = {
  waiting: 0,
  working: 1,
  starting: 2,
  idle: 3,
  unknown: 4,
  ended: 5,
};

export interface AgentsViewProps {
  /** This tab is the one in front. Everything that polls is gated on it. */
  active: boolean;
  projectName: string;
  roots: string[];
  stats: ipc.SessionStats[];
  hookPath: string | null;
  pending?: PendingItem[];
  onDismissPending?: (key: string) => void;
  onAnswer?: (item: PendingItem, selections: number[][]) => void;
  onRespond?: (item: PendingItem, decision: "approve" | "deny") => void;
  onJumpToTerminal?: (item: PendingItem) => void;
  /** Focus the tab a running session is in. */
  onJumpToPty?: (ptyId: number) => void;
  /** Open an agent's workspace tab: files, diffs, commits and PR. */
  onOpenAgent?: (p: {
    agent: string;
    cwd: string;
    ptyId: number;
    sessionId?: string;
    digest?: ipc.SessionDigest;
  }) => void;
  onPreviewUrl?: (url: string) => void;
  /** What each running pty's tab is called, so the cards and the tab strip say
   *  the same thing about the same session. */
  tabNames?: Map<number, TabName>;
  shareContext: boolean;
  onShareContext: (on: boolean) => void;
  liveSessionIds?: string[];
  /** Reopen a past session: runs `cmd` in `cwd` as a new terminal. */
  onRestore?: (cwd: string, cmd: string, title: string, agentId: string) => void;
  /** Open the agent-instructions tab. */
  onOpenInstructions?: (focus?: string) => void;
  /** Open one file claim as its own tab — who took it, why, and what it has
   *  turned away since. */
  onOpenClaim?: (claim: ipc.AgentClaim) => void;
}

/** One number with its name under it. Five of these across the top is the whole
 *  "how is this project doing" question, answered before you read a card. */
function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string | number;
  tone?: "attention" | "active" | "quiet";
  title?: string;
}) {
  return (
    <div className={`agv-stat ${tone ? `agv-stat-${tone}` : ""}`} title={title}>
      <span className="agv-stat-value">{value}</span>
      <span className="agv-stat-label">{label}</span>
    </div>
  );
}

function Section({
  title,
  count,
  note,
  action,
  children,
}: {
  title: string;
  count?: number;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="agv-section">
      <header className="agv-section-head">
        <h2>{title}</h2>
        {count != null && <span className="badge">{count}</span>}
        {note && <span className="agv-section-note">{note}</span>}
        <span className="agv-spacer" />
        {action}
      </header>
      {children}
    </section>
  );
}

export function AgentsView({
  active,
  projectName,
  roots,
  stats,
  hookPath,
  pending = [],
  onDismissPending,
  onAnswer,
  onRespond,
  onJumpToTerminal,
  onJumpToPty,
  onOpenAgent,
  onPreviewUrl,
  tabNames,
  shareContext,
  onShareContext,
  liveSessionIds = [],
  onRestore,
  onOpenInstructions,
  onOpenClaim,
}: AgentsViewProps) {
  const { agentSessions, termSessions, restorable, shared, claims, forget, lifeOf } =
    useAgentSessions({ visible: active, roots, stats, liveSessionIds });
  const integrations = useIntegrations(active);
  const settings = getSettings();

  // What each session has spent. One call for the lot, refreshed slowly: this
  // is an accounting number, not a lifecycle signal, and nobody watches it tick.
  const [usage, setUsage] = useState<ipc.AgentSessionUsage[]>([]);
  useEffect(() => {
    if (!active) return;
    const load = () => void ipc.agentUsage().then(setUsage).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [active]);
  const usageById = useMemo(
    () => new Map(usage.map((u) => [u.session_id, u])),
    [usage],
  );

  const now = Date.now() / 1000;
  const cards = useMemo(() => {
    return agentSessions
      .map((row) => ({ row, life: lifeOf(row) }))
      .sort(
        (a, b) =>
          RANK[a.life.state] - RANK[b.life.state] ||
          (b.row.digest?.updated ?? 0) - (a.row.digest?.updated ?? 0),
      );
  }, [agentSessions, lifeOf]);

  const working = cards.filter((c) => c.life.state === "working").length;
  const blocked = cards.filter(
    (c) => bucketFor(c.life, NO_ATTENTION) === "attention",
  ).length;
  const liveSpend = cards.reduce((sum, c) => {
    const u = c.row.digest?.session_id
      ? usageById.get(c.row.digest.session_id)
      : undefined;
    return sum + (u ? (sessionCost(u) ?? 0) : 0);
  }, 0);

  const urgent = pending.filter((i) => i.kind !== "idle");
  const finished = pending.filter((i) => i.kind === "idle");

  // The archive is the one list here long enough to need finding things in.
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return restorable;
    return restorable.filter((r) =>
      [r.agentId, r.cwd, r.digest.branch, lastHumanPrompt(r.digest.prompts)]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q)),
    );
  }, [restorable, query]);

  const agentCard = ({ row, life }: { row: SessionRow; life: ReturnType<typeof lifeOf> }) => {
    const { session: s, agent, digest, dir } = row;
    const runaway =
      s.total_cpu > settings.runawayCpuPercent ||
      s.total_mem_bytes > settings.runawayMemBytes;
    const st = LIFE_META[life.state];
    const look = ashFor(life.state);
    const stTitle =
      life.state === "unknown"
        ? `${life.note} (silent for ${silenceLabel(digest?.updated, now)})`
        : life.note || st.label;
    // Only reclaim an agent that has *provably* finished — never one mid-turn,
    // never one blocked, and never one we have merely lost track of.
    const canHibernate = reclaimable(life, NO_ATTENTION);
    const task = lastHumanPrompt(digest?.prompts);
    const name = agentDisplayName({
      tab: tabNames?.get(s.id),
      agentLabel: agent?.label,
      sessionTitle: s.title,
    });
    const u = digest?.session_id ? usageById.get(digest.session_id) : undefined;
    const cost = u ? sessionCost(u) : null;
    const blockedHere = bucketFor(life, NO_ATTENTION) === "attention";
    return (
      <article
        key={s.id}
        className={`agv-card ${runaway ? "agv-card-runaway" : ""} ${
          blockedHere ? "agv-card-attention" : ""
        }`}
      >
        <header className="agv-card-head">
          <Mascot state={look.state} tone={look.tone} size={20} title={stTitle} />
          <div className="agv-card-id">
            <span className="agv-card-name" title={s.cwd}>
              {agent?.id ? (
                <AgentIcon id={agent.id} size={14} className="agv-card-mark" />
              ) : (
                <TerminalIcon size={13} className="agv-card-mark" />
              )}
              {name}
            </span>
            <span className={`agv-card-state ${st.cls}`} title={stTitle}>
              {st.label}
            </span>
          </div>
          <span className="agv-spacer" />
          <AgentRuntime timing={digest} live={life.state === "working"} />
        </header>

        {/* Where it is and what it is spending — everything that tells two
            otherwise identical sessions apart. */}
        <div className="agv-chips">
          {dir && (
            <span className="agv-chip" title={s.cwd}>
              {dir}
            </span>
          )}
          {digest?.branch && (
            <span className="agv-chip agv-chip-branch" title={`On branch ${digest.branch}`}>
              ⎇ {digest.branch}
            </span>
          )}
          {digest?.profile && digest.profile !== "default" && (
            <span
              className="agv-chip"
              title={`Running under the "${digest.profile}" account`}
            >
              {digest.profile}
            </span>
          )}
          {(digest?.subagents ?? 0) > 0 && (
            <span
              className="agv-chip"
              title={`${digest?.subagents} subagent${digest?.subagents === 1 ? "" : "s"} finished this turn`}
            >
              ⑃ {digest?.subagents}
            </span>
          )}
          {blockedHere && (
            <span className="agv-chip agv-chip-attention" title="Waiting for your answer">
              needs you
            </span>
          )}
          {runaway && (
            <span className="agv-chip agv-chip-warn" title="Using far more CPU or memory than expected">
              runaway?
            </span>
          )}
          {s.ports?.map((p) => (
            <button
              key={p}
              className="agv-chip agv-chip-port"
              title={`Open http://localhost:${p} in Canopy`}
              onClick={() => onPreviewUrl?.(`http://localhost:${p}`)}
            >
              :{p}
            </button>
          ))}
        </div>

        {/* The highest-signal line about a session: "fix the login redirect"
            identifies it in a way cpu, memory and a directory never will. Two
            lines here, where the panel could afford one. */}
        <p className={`agv-task ${task ? "" : "agv-task-none"}`}>
          {task ?? "No prompt recorded for this session yet."}
        </p>

        {/* Numbers on one line, actions on the other. They used to share a
            wrapping row, so a session with tokens and a cost pushed its own
            buttons onto a second line and no two cards agreed where the kill
            button was. */}
        <footer className="agv-card-foot">
          <div className="agv-card-metrics">
            <span className="agv-metric" title="CPU across every process in this terminal">
              {s.total_cpu.toFixed(0)}% cpu
            </span>
            <span className="agv-metric" title="Resident memory across every process in this terminal">
              {fmtMem(s.total_mem_bytes)}
            </span>
            {u && (
              <span
                className="agv-metric"
                title={`${u.turns} turn${u.turns === 1 ? "" : "s"}${u.model ? ` · ${u.model}` : ""}`}
              >
                {fmtTokens(u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens)} in ·{" "}
                {fmtTokens(u.output_tokens)} out
              </span>
            )}
            {cost != null && cost > 0 && (
              <span className="agv-metric agv-metric-cost">{fmtCost(cost)}</span>
            )}
          </div>
          <div className="agv-card-acts">
          <Button size="sm" title="Go to this agent's terminal" onClick={() => onJumpToPty?.(s.id)}>
            <TerminalIcon size={12} /> Terminal
          </Button>
          {agent?.id && onOpenAgent && (
            <Button
              size="sm"
              title="Open this agent's workspace — files, diffs, commits and PR"
              onClick={() =>
                onOpenAgent({
                  agent: agent.id ?? "agent",
                  cwd: s.cwd,
                  ptyId: s.id,
                  sessionId: digest?.session_id,
                  digest,
                })
              }
            >
              <DiffIcon size={12} /> Workspace
            </Button>
          )}
          {canHibernate && (
            <Button
              icon
              size="sm"
              title="Hibernate — frees memory now; resume later from Past sessions with its history"
              onClick={() => void ipc.ptyKill(s.id)}
            >
              <MoonIcon size={12} />
            </Button>
          )}
          <Button
            icon
            size="sm"
            variant="danger"
            title={`Kill terminal #${s.id}${agent ? ` and the ${agent.label} running in it` : ""}`}
            onClick={() => void ipc.ptyKill(s.id)}
          >
            ✕
          </Button>
          </div>
        </footer>
      </article>
    );
  };

  return (
    <div className="agv">
      <header className="agv-head">
        <div className="agv-title">
          <h1>Agents</h1>
          <span className="agv-project">{projectName}</span>
          <span className="agv-spacer" />
          <Button
            size="sm"
            title="CLAUDE.md, AGENTS.md, skills and subagents — what every agent here reads first"
            onClick={() => onOpenInstructions?.()}
          >
            <DocumentIcon size={12} /> Instructions
          </Button>
          {/* Opt-in, and stated rather than hidden behind a question mark: on a
              page this wide there is room to say what it does. */}
          <span className="agv-share" title="Before each prompt, an agent here is told the recent prompts you gave the other sessions in this project and the files they touched.">
            <ExchangeIcon size={13} />
            <span className="agv-share-label">Shared context</span>
            {shareContext && (
              <span className="agv-share-count">
                {shared.length} session{shared.length === 1 ? "" : "s"}
              </span>
            )}
            <Switch
              checked={shareContext}
              onChange={onShareContext}
              aria-label="Share context between agents in this project"
            />
          </span>
        </div>

        <div className="agv-stats">
          <Stat label="running" value={cards.length} tone={cards.length ? "active" : undefined} />
          <Stat label="working" value={working} />
          <Stat
            label="waiting on you"
            value={blocked}
            tone={blocked > 0 ? "attention" : undefined}
            title="Agents blocked on an answer from you"
          />
          <Stat label="terminals" value={termSessions.length} tone="quiet" />
          <Stat label="past sessions" value={restorable.length} tone="quiet" />
          {liveSpend > 0 && (
            <Stat
              label="spent"
              value={fmtCost(liveSpend)}
              tone="quiet"
              title="Across the sessions running right now, for the CLIs that report usage"
            />
          )}
        </div>
      </header>

      <div className="agv-body">
        {urgent.length > 0 && (
          <Section title="Needs your input" count={urgent.length}>
            <div className="agv-pending">
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
            </div>
          </Section>
        )}

        <Section
          title="Running agents"
          count={cards.length}
          note={cards.length > 0 ? "blocked first, then working" : undefined}
        >
          {cards.length === 0 ? (
            <div className="agv-empty">
              <Mascot state="sleeping" size={72} />
              <p>
                Nothing running here. Launch <code>claude</code>, <code>codex</code> or any other
                CLI from the ＋ menu, or by right-clicking a component.
              </p>
            </div>
          ) : (
            <div className="agv-cards">{cards.map(agentCard)}</div>
          )}
        </Section>

        {finished.length > 0 && (
          <Section title="Finished" count={finished.length}>
            <div className="agv-pending">
              {finished.map((item) => (
                <PendingCard
                  key={item.key}
                  item={item}
                  onJumpToTerminal={onJumpToTerminal}
                  onDismiss={onDismissPending}
                />
              ))}
            </div>
          </Section>
        )}

        {termSessions.length > 0 && (
          <Section title="Terminals" count={termSessions.length}>
            <div className="agv-terms">
              {termSessions.map(({ session: s, dir }) => (
                <div
                  key={s.id}
                  className="agv-term"
                  onClick={() => onJumpToPty?.(s.id)}
                  title={`${s.cwd}\nClick to jump to this terminal`}
                >
                  <TerminalIcon size={13} className="agv-card-mark" />
                  <span className="agv-term-name">{s.title || "shell"}</span>
                  {dir && <span className="agv-chip">{dir}</span>}
                  <span className="agv-spacer" />
                  <span className="agv-metric">{s.total_cpu.toFixed(0)}% cpu</span>
                  <span className="agv-metric">{fmtMem(s.total_mem_bytes)}</span>
                  <Button
                    icon
                    size="sm"
                    variant="danger"
                    title={`Kill terminal #${s.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void ipc.ptyKill(s.id);
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          </Section>
        )}

        {claims.length > 0 && (
          <Section
            title="Claimed files"
            count={claims.length}
            note="advisory — agents check these before editing"
          >
            <div className="agv-claims">
              {claims.map((claim) => (
                <div
                  key={claim.id}
                  className="agv-claim"
                  onClick={() => onOpenClaim?.(claim)}
                  title={`${claim.owner}\n${claim.paths.join("\n")}\nClick to open this claim`}
                >
                  <span className="agv-claim-owner">
                    {claimOwnerName(claim.owner)}
                  </span>
                  <span className="agv-claim-paths">
                    {claim.note ? `${claim.note} — ` : ""}
                    {claim.paths.map((p) => basename(p)).join(", ")}
                  </span>
                  <span className="agv-spacer" />
                  <span className="agv-claim-when">{ago(claim.at_ms / 1000)}</span>
                  <Button
                    size="sm"
                    title="Drop this claim — for an agent that died holding it"
                    onClick={(e) => {
                      e.stopPropagation();
                      void ipc.contextReleaseClaim(claim.owner).catch(() => {});
                    }}
                  >
                    Release
                  </Button>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section
          title="Past sessions"
          count={restorable.length}
          note="reopening runs the agent's own resume, so it comes back with its history"
          action={
            restorable.length > 4 ? (
              <TextInput
                search
                size="sm"
                width="sm"
                placeholder="Filter by prompt, branch, directory"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : undefined
          }
        >
          {restorable.length === 0 ? (
            <p className="agv-none">
              Nothing to bring back — sessions appear here once their terminal closes.
            </p>
          ) : matches.length === 0 ? (
            <p className="agv-none">No past session matches “{query}”.</p>
          ) : (
            <div className="agv-past">
              {matches.map(({ digest: d, agentId, cwd: runIn, command: cmd, superseded }) => {
                // runIn is resume_cwd, not cwd: claude looks the conversation up
                // under its project root, so resuming from the subdirectory the
                // agent ran in reports "No conversation found".
                const dir = basename(runIn);
                const last = lastHumanPrompt(d.prompts);
                return (
                  <div key={d.session_id} className="agv-past-row">
                    <AgentIcon id={agentId} size={15} className="agv-card-mark" />
                    <div className="agv-past-main">
                      <div className="agv-past-line">
                        <span className="agv-past-agent">{agentId}</span>
                        <AgentRuntime timing={d} live={false} />
                        {dir && (
                          <span className="agv-chip" title={runIn}>
                            {dir}
                          </span>
                        )}
                        {d.branch && (
                          <span className="agv-chip agv-chip-branch">⎇ {d.branch}</span>
                        )}
                        <span className="agv-past-when">{ago(d.updated)}</span>
                      </div>
                      <div className="agv-past-prompt">
                        {last ?? <em>(no prompt captured for this session)</em>}
                      </div>
                    </div>
                    <div className="agv-past-acts">
                      <Button
                        size="sm"
                        title={`Restore this session — ${cmd}`}
                        onClick={() => {
                          // Bridge the gap until the resumed agent's first hook
                          // event rewrites the digest's surface; without it the
                          // row sits here looking un-restored for a few seconds.
                          markRestored(d.session_id);
                          onRestore?.(runIn, cmd, agentId, agentId);
                        }}
                      >
                        <RestartIcon size={12} /> Restore
                      </Button>
                      <Button
                        icon
                        size="sm"
                        title={
                          superseded.length > 0
                            ? `Forget this directory's ${superseded.length + 1} sessions`
                            : "Forget this session — removes it from this list"
                        }
                        onClick={() => forget([d, ...superseded])}
                      >
                        <TrashIcon size={12} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        <Section
          title="Integrations"
          note="what each CLI streams into Canopy, and the one click that wires it"
        >
          <IntegrationsList health={integrations.health} onSetUp={(a) => void integrations.setUp(a)} spacious />
          {integrations.result && <pre className="agv-setup-result">{integrations.result}</pre>}
          {hookPath && (
            <p className="agv-hook-path">
              Any other CLI: point a hook at appending single-line JSON to{" "}
              <code>{hookPath}</code>
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}

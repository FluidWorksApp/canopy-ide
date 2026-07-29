// SpotSearch's result sources: every kind of thing the omnibox can find, each
// as a small function from (query, context) to rows. The palette component
// composes them — cheap sources answer synchronously on every keystroke, the
// expensive ones (file contents, LSP symbols, the persistent index, trackers)
// are debounced and land when they land.
//
// One rule from the rest of the app applies here with force: every row opens
// something native (see openers in ProjectView). A source that can't say what
// Enter would open drops the row instead of showing it.
import * as ipc from "./ipc";
import { fuzzy } from "./fuzzy";
import type { ServerGroup } from "./servers";
import type { SubTab, TermSubTab } from "./components/ProjectView/helpers";
import { tabDisplayLabel } from "./components/ProjectView/helpers";
import { completedTaskRuns, type TaskRun } from "./taskHistory";
import { TRACKERS } from "./trackers";
import { cached as researchCached, STATUS_LABELS as RESEARCH_STATUS_LABELS } from "./research";
import { getSnapshot as prSnapshot } from "./prWatchStore";
import { toPrInfo } from "./prInbox";
import { getSettings } from "./settings";
import { heldBadge, heldBranches } from "./branchSwitch";

/** What Enter does on a row — ProjectView owns the dispatch, this names it. */
export type SpotAction =
  | { type: "run-task"; brief: string }
  | { type: "new-shell" }
  | { type: "new-preview" }
  | { type: "new-device" }
  | { type: "launch-cli"; cliId: string }
  | { type: "open-file"; path: string; line?: number }
  | { type: "focus-tab"; tabId: string }
  | { type: "open-session"; digest: ipc.SessionDigest }
  | { type: "open-ticket"; source: string; ticket: ipc.TicketInfo }
  | { type: "open-research"; id: string }
  /** Send what was typed off as a research run — the sibling of `run-task`.
   *  Named rather than run through `custom` for the same reason
   *  `switch-branch` is: creating the entry and launching the agent has to
   *  reach ProjectView's launcher, and a module-level closure cannot. */
  | { type: "start-research"; question: string }
  | { type: "open-pr"; repo: string; pr: ipc.PrInfo }
  | { type: "open-server"; path: string; tabId: string | null }
  | { type: "open-task-run"; runId: string }
  /** Switch this repo to a branch. Named here rather than run through `custom`
   *  because the switch has to reach the shared funnel (useBranchSwitch), and a
   *  module-level closure can't — only ProjectView's dispatch is inside the
   *  provider. */
  | { type: "switch-branch"; repo: string; branch: string }
  /** The escape hatch for registered sources: the row does its own opening.
   *  Still bound by the rule above — `run` must land the user on something
   *  native, not open a browser and call it a result. */
  | { type: "custom"; run: () => void | Promise<void> };

export interface SpotRow {
  id: string;
  /** Section heading the palette groups under. */
  group: string;
  /** What this row *is*, for the palette's icon column — a tab type, or one of
   *  the parametric forms `cli:<id>` / `agent:<id>` / `tracker:<id>`. Naming the
   *  kind rather than picking a glyph here keeps the mark the palette's choice
   *  (see rowIcon in SpotSearch). */
  kind?: string;
  /** A literal glyph, for rows that carry their own (task runs). Only used when
   *  `kind` maps to nothing. */
  icon?: string;
  title: string;
  detail?: string;
  /** Lower ranks earlier within its group (fuzzy score). */
  score: number;
  action: SpotAction;
}

/** What the palette knows about the project it's floating over. */
export interface SpotContext {
  components: { label: string; path: string }[];
  tabs: SubTab[];
  serverGroups: ServerGroup[];
  digests: ipc.SessionDigest[];
  projectId: string;
  clis: { id: string; name: string }[];
  installed: Record<string, boolean>;
}

const CAP = 6;

/** Rank `rows` by fuzzy match on their searchable text; empty query keeps the
 *  given order. */
function ranked(
  query: string,
  rows: { row: SpotRow; hay: string }[],
  cap = CAP,
): SpotRow[] {
  const q = query.trim();
  if (!q) return rows.slice(0, cap).map((r) => r.row);
  return rows
    .map(({ row, hay }) => ({ row, s: fuzzy(q, hay) }))
    .filter((r): r is { row: SpotRow; s: number } => r.s !== null)
    .sort((a, b) => a.s - b.s)
    .slice(0, cap)
    .map((r) => ({ ...r.row, score: r.s }));
}

// ---------- synchronous sources ----------

/** The launcher entries (LaunchPalette's set, folded in) plus the one row that
 *  is always offered on a non-empty query: run what you typed as a one-shot
 *  agent task with the current page as context. */
export function actionRows(query: string, ctx: SpotContext, attachments = 0): SpotRow[] {
  const q = query.trim();
  const launchers: { row: SpotRow; hay: string }[] = [
    {
      hay: "new shell terminal",
      row: {
        id: "act:shell",
        group: "Actions",
        kind: "shell",
        title: "New Shell",
        score: 0,
        action: { type: "new-shell" },
      },
    },
    {
      hay: "new preview browser",
      row: {
        id: "act:preview",
        group: "Actions",
        kind: "preview",
        title: "New Preview",
        score: 0,
        action: { type: "new-preview" },
      },
    },
    {
      hay: "new android device emulator preview",
      row: {
        id: "act:device",
        group: "Actions",
        kind: "device",
        title: "New Android Device",
        score: 0,
        action: { type: "new-device" },
      },
    },
    ...ctx.clis.map((cli) => ({
      hay: `launch agent ${cli.name}`,
      row: {
        id: `act:cli:${cli.id}`,
        group: "Actions",
        kind: `cli:${cli.id}`,
        title: `New ${cli.name}`,
        score: 0,
        action: { type: "launch-cli", cliId: cli.id } as SpotAction,
      },
    })),
  ];
  const rows = ranked(query, launchers, 4);
  // A pasted image is a thing to send even with nothing typed — offering only
  // "New Shell" to someone who just pasted a screenshot answers a question
  // nobody asked.
  if (q || attachments > 0) {
    // The two things you can send a typed sentence off as, side by side. They
    // are genuinely different jobs — one changes the code and disappears, the
    // other answers a question and leaves the answer behind — and asking which
    // one you meant is cheaper than guessing from the wording.
    rows.unshift(
      {
        id: "act:run-task",
        group: "Actions",
        kind: "run-task",
        title: q ? `Run task: “${q}”` : "Run task on the pasted image",
        detail: attachments > 0 ? "one-shot agent · with the image" : "one-shot agent · current page as context",
        score: -2,
        action: { type: "run-task", brief: q },
      },
      {
        id: "act:research",
        group: "Actions",
        kind: "research",
        title: q ? `Research: “${q}”` : "Research the pasted image",
        detail: "investigate and record it · nothing is changed",
        score: -1,
        action: { type: "start-research", question: q },
      },
    );
  }
  return rows;
}

/** Research already recorded in this project. Instant, from the cache
 *  research.ts keeps — so an entry that answers what you are typing shows up on
 *  the first keystroke, which is the only version of "findable" that stops
 *  someone researching it twice. */
export function researchRows(query: string, projectId: string): SpotRow[] {
  return ranked(
    query,
    researchCached(projectId).map((entry) => ({
      hay: `${entry.title} ${entry.digest} ${entry.tags.join(" ")}`,
      row: {
        id: `research:${entry.id}`,
        group: "Research",
        kind: "research",
        title: entry.title,
        // Status leads: whether this is a finding nobody has acted on or one
        // that already shipped changes what you do with it, and that is worth
        // knowing before the click rather than after.
        detail: [
          RESEARCH_STATUS_LABELS[entry.status] ?? entry.status,
          entry.digest,
        ]
          .filter(Boolean)
          .join(" · "),
        score: 0,
        action: { type: "open-research", id: entry.id } as SpotAction,
      },
    })),
  );
}

export function tabRows(query: string, ctx: SpotContext): SpotRow[] {
  return ranked(
    query,
    ctx.tabs.map((t) => {
      const label = tabDisplayLabel(t);
      return {
        hay: label,
        row: {
          id: `tab:${t.id}`,
          group: "Open Tabs",
          kind: t.type,
          title: label,
          detail: t.type,
          score: 0,
          action: { type: "focus-tab", tabId: t.id } as SpotAction,
        },
      };
    }),
  );
}

export function serverRows(query: string, ctx: SpotContext): SpotRow[] {
  const entries = ctx.serverGroups.flatMap((g) =>
    g.entries.map((e) => ({
      hay: `${e.name} ${e.command} ${g.label}`,
      row: {
        id: `srv:${g.path}:${e.key}`,
        group: "Servers",
        kind: "server",
        title: e.name,
        detail:
          e.state === "running"
            ? `running${e.ports.length ? ` · :${e.ports.join(" :")}` : ""}`
            : e.state,
        score: 0,
        action: { type: "open-server", path: g.path, tabId: e.tabId } as SpotAction,
      },
    })),
  );
  return ranked(query, entries);
}

export function sessionRows(query: string, ctx: SpotContext): SpotRow[] {
  const rows = ctx.digests
    .filter((d) => !d.micro)
    .map((d) => {
      const prompt = d.prompts?.[d.prompts.length - 1] ?? "";
      const hay = [d.agent, d.branch, prompt, ...(d.prompts ?? []), ...(d.files ?? [])]
        .filter(Boolean)
        .join(" ");
      return {
        hay,
        row: {
          id: `ses:${d.session_id}`,
          group: "Agent Sessions",
          kind: `agent:${d.agent ?? ""}`,
          title: `${d.agent ?? "agent"}${d.branch ? ` · ${d.branch}` : ""}`,
          detail: prompt,
          score: 0,
          action: { type: "open-session", digest: d } as SpotAction,
        },
      };
    });
  return ranked(query, rows);
}

export function taskRows(query: string, ctx: SpotContext): SpotRow[] {
  const runs = completedTaskRuns(ctx.projectId).slice(0, 50);
  return ranked(
    query,
    runs.map((r: TaskRun) => ({
      hay: `${r.label} ${r.brief} ${r.summary ?? ""}`,
      row: {
        id: `run:${r.id}`,
        group: "Task History",
        kind: "task",
        icon: r.icon,
        title: r.label,
        detail: r.summary ?? r.status,
        score: 0,
        action: { type: "open-task-run", runId: r.id } as SpotAction,
      },
    })),
  );
}

/** Open PRs, from the PR watcher's shared store — already fetched, never a
 *  round trip here. Empty until something (the panel, a badge) started it. */
export function prRows(query: string): SpotRow[] {
  return ranked(
    query,
    prSnapshot().rows.map((r) => ({
      hay: `#${r.number} ${r.title} ${r.branch} ${r.author}`,
      row: {
        id: `pr:${r.nwo}#${r.number}`,
        group: "Pull Requests",
        kind: "pr",
        title: `#${r.number} ${r.title}`,
        detail: r.branch,
        score: 0,
        action: { type: "open-pr", repo: r.repo, pr: toPrInfo(r) } as SpotAction,
      },
    })),
  );
}

// ---------- async sources ----------

export async function fileRows(query: string, corpus: string[]): Promise<SpotRow[]> {
  if (!query.trim()) return [];
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  return corpus
    .map((p) => ({ p, s: fuzzy(query, base(p)) ?? fuzzy(query, p) }))
    .filter((r): r is { p: string; s: number } => r.s !== null)
    .sort((a, b) => a.s - b.s)
    .slice(0, CAP)
    .map((r) => ({
      id: `file:${r.p}`,
      group: "Files",
      kind: "file",
      title: base(r.p),
      detail: r.p,
      score: r.s,
      action: { type: "open-file", path: r.p } as SpotAction,
    }));
}

export async function contentRows(query: string, roots: string[]): Promise<SpotRow[]> {
  if (query.trim().length < 2) return [];
  const hits = await ipc.fsSearch(roots, query, 30).catch(() => []);
  return hits.slice(0, CAP).map((h) => ({
    id: `hit:${h.path}:${h.line}`,
    group: "In Files",
    kind: "match",
    title: `${h.path.slice(h.path.lastIndexOf("/") + 1)}:${h.line}`,
    detail: h.text.trim(),
    score: 0,
    action: { type: "open-file", path: h.path, line: h.line } as SpotAction,
  }));
}

/** Workspace symbols from the language servers already running — deliberately
 *  never starts one (same call as canopy_symbols: a palette keystroke must not
 *  pay for a cold rust-analyzer index). Cold project, no rows. */
export async function codeSymbolRows(query: string, roots: string[]): Promise<SpotRow[]> {
  if (query.trim().length < 2) return [];
  // Imported lazily: lsp/client pulls Monaco in, which the palette must not
  // load (or pay for) unless a symbol search actually runs.
  const { runningServersUnder, workspaceRequest } = await import("./lsp/client");
  const { sortRows, symbolRows: lspSymbolRows } = await import("./lsp/symbols");
  const rows = [];
  for (const root of roots) {
    if (runningServersUnder(root).length === 0) continue;
    for (const { result } of await workspaceRequest(root, "workspace/symbol", {
      query: query.trim(),
    }).catch(() => [] as { result: unknown }[])) {
      rows.push(...lspSymbolRows(result));
    }
  }
  return sortRows(rows)
    .slice(0, CAP)
    .map((s) => ({
      id: `sym:${s.path}:${s.line}:${s.name}`,
      group: "Symbols",
      kind: "symbol",
      title: s.name,
      detail: `${s.kind} · ${s.path.slice(s.path.lastIndexOf("/") + 1)}:${s.line}`,
      score: 0,
      action: { type: "open-file", path: s.path, line: s.line } as SpotAction,
    }));
}

/** Hits from the persistent index (transcripts + terminal scrollback), mapped
 *  back to something openable: a terminal hit to its live tab, a transcript hit
 *  to its session digest. A hit whose container is gone is dropped, not shown. */
export async function indexRows(query: string, ctx: SpotContext, roots: string[]): Promise<SpotRow[]> {
  if (query.trim().length < 2) return [];
  const { spotSearchAllProjects } = getSettings();
  const hits = await ipc
    .spotSearch(query, 14, roots, spotSearchAllProjects)
    .catch(() => []);
  const out: SpotRow[] = [];
  const dir = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  for (const h of hits) {
    if (h.kind === "terminal") {
      const ptyId = Number(h.key.slice("pty:".length));
      const tab = ctx.tabs.find(
        (t): t is TermSubTab => t.type === "terminal" && t.ptyId === ptyId,
      );
      if (!tab) continue;
      out.push({
        id: `spot:${h.kind}:${h.key}`,
        group: "Terminal Output",
        kind: "terminal",
        title: tabDisplayLabel(tab),
        detail: h.snippet,
        score: 0,
        action: { type: "focus-tab", tabId: tab.id },
      });
      continue;
    }
    // Aider keeps its history as a file in the repo and has no session to
    // reopen — so the row opens the history itself. Every other agent's
    // conversation opens as a session.
    if (h.agent === "aider") {
      out.push({
        id: `spot:${h.kind}:${h.key}`,
        group: "Agent Sessions",
        kind: "agent:aider",
        title: `aider · ${dir(h.cwd)}`,
        detail: h.snippet,
        score: 0,
        action: { type: "open-file", path: h.meta },
      });
      continue;
    }
    // A digest is the richer record (branch, files, the surface it ran on), but
    // its absence must not lose the row: the hit already carries what opening
    // a session needs, and dropping it was how whole agents went missing from
    // search while their conversations sat in the index.
    const digest: ipc.SessionDigest = ctx.digests.find(
      (d) => d.session_id === h.key,
    ) ?? {
      session_id: h.key,
      agent: h.agent,
      cwd: h.cwd,
      launch_cwd: h.cwd,
      resume_cwd: h.cwd,
      updated: h.ts,
      prompts: [],
    };
    out.push({
      id: `spot:${h.kind}:${h.key}`,
      group: "Agent Sessions",
      kind: `agent:${digest.agent ?? h.agent}`,
      title: `${digest.agent ?? h.agent}${
        digest.branch ? ` · ${digest.branch}` : h.cwd ? ` · ${dir(h.cwd)}` : ""
      }`,
      detail: h.snippet,
      score: 0,
      action: { type: "open-session", digest },
    });
  }
  return out.slice(0, CAP);
}

/** Tracker tickets, cached briefly — the fetch can be a `gh` round trip per
 *  repo, which is not a per-keystroke cost. */
let ticketCache: {
  at: number;
  key: string;
  rows: { source: string; ticket: ipc.TicketInfo }[];
} | null = null;
const TICKET_TTL = 60_000;

export async function ticketRows(query: string, repos: string[]): Promise<SpotRow[]> {
  if (!query.trim()) return [];
  const key = repos.join("\n");
  if (!ticketCache || ticketCache.key !== key || Date.now() - ticketCache.at > TICKET_TTL) {
    const rows: { source: string; ticket: ipc.TicketInfo }[] = [];
    await Promise.all(
      TRACKERS.map(async (provider) => {
        const available = await provider.available(repos).catch(() => ({ ok: false }));
        if (!available.ok) return;
        for (const repo of repos) {
          const list = await provider.fetch(repo).catch(() => [] as ipc.TicketInfo[]);
          rows.push(...list.map((ticket) => ({ source: provider.id, ticket })));
          if (provider.scope === "global") break;
        }
      }),
    );
    ticketCache = { at: Date.now(), key, rows };
  }
  return ranked(
    query,
    ticketCache.rows.map(({ source, ticket }) => ({
      hay: `${ticket.id} ${ticket.title} ${ticket.state}`,
      row: {
        id: `tik:${source}:${ticket.id}`,
        group: "Tickets",
        kind: `tracker:${source}`,
        title: `${ticket.id} ${ticket.title}`,
        detail: ticket.state,
        score: 0,
        action: { type: "open-ticket", source, ticket } as SpotAction,
      },
    })),
  );
}

/** Branches, so "switch to the thing I'm thinking of" works from wherever the
 *  user is rather than only from the Git panel. Cached like tickets: two git
 *  processes per repo (the branches, and the workspaces that already hold some
 *  of them) is not a per-keystroke cost. */
let branchCache: {
  at: number;
  key: string;
  rows: { repo: string; branch: ipc.BranchInfo; held: ipc.WorktreeInfo | undefined }[];
} | null = null;
const BRANCH_TTL = 15_000;

export async function branchRows(query: string, repos: string[]): Promise<SpotRow[]> {
  if (!query.trim()) return [];
  const key = repos.join("\n");
  if (!branchCache || branchCache.key !== key || Date.now() - branchCache.at > BRANCH_TTL) {
    const lists = await Promise.all(
      repos.map(async (repo) => {
        const [branches, worktrees] = await Promise.all([
          ipc.gitBranches(repo).catch(() => [] as ipc.BranchInfo[]),
          ipc.gitWorktrees(repo).catch(() => [] as ipc.WorktreeInfo[]),
        ]);
        const held = heldBranches(worktrees, repo);
        return (
          branches
            // Switching to where you already are is not a result.
            .filter((branch) => !branch.current)
            .map((branch) => ({ repo, branch, held: held.get(branch.name) }))
        );
      }),
    );
    branchCache = { at: Date.now(), key, rows: lists.flat() };
  }
  return ranked(
    query,
    branchCache.rows.map(({ repo, branch, held }) => ({
      hay: `${branch.name} ${branch.subject}`,
      row: {
        id: `br:${repo}:${branch.name}`,
        group: "Branches",
        kind: "branch",
        title: branch.name,
        // The badge leads: a long subject truncates, and knowing another
        // workspace has this branch is worth more before the click than after
        // — the same courtesy the Git panel's rows give.
        detail: [
          held ? heldBadge(held).label : null,
          branch.remote_only ? "not here yet" : null,
          branch.subject,
        ]
          .filter(Boolean)
          .join(" · "),
        score: 0,
        action: { type: "switch-branch", repo, branch: branch.name } as SpotAction,
      },
    })),
  );
}

// ---------- the registry ----------
//
// The palette doesn't know this file's functions — it asks the registry below,
// so a new kind of thing to search is a `registerSpotSource` call and nothing
// else. Everything above is registered through the same door a plugin uses;
// there is no privileged built-in path, which is the only version that stays
// honest as sources are added.
//
//   registerSpotSource({
//     id: "notes",
//     group: "Notes",
//     timing: "deferred",
//     minQuery: 2,
//     rows: async ({ query }) => (await findNotes(query)).map((n) => ({
//       id: `note:${n.id}`,
//       group: "Notes",
//       kind: "file",
//       title: n.title,
//       score: 0,
//       action: { type: "custom", run: () => openNote(n.id) },
//     })),
//   });
//
// Sections render in registration order, so where a source is registered is
// where its rows appear. A source that throws (or rejects) is dropped for that
// keystroke — one bad source must not empty the palette.

/** What a source is handed. `corpus` and `roots` are computed once when the
 *  palette opens, so a source never walks the tree itself. */
export interface SpotQuery {
  query: string;
  ctx: SpotContext;
  /** Every file under the project's components. */
  corpus: string[];
  /** Component roots, in order. */
  roots: string[];
  /** Images pasted into the field. Only the count reaches here: the palette
   *  owns the files, and the sources only need to know that a bare Enter has
   *  something to send even with nothing typed. */
  attachments?: number;
}

export interface SpotSource {
  /** Stable id — also what `before` in registration points at, and the key
   *  Settings → SpotSearch stores when it's switched off. */
  id: string;
  /** Section heading its rows land under. Rows carry their own `group`, so a
   *  source may fill more than one; this one decides its place in the order. */
  group: string;
  /** One line for the settings screen: what this source actually searches.
   *  Optional so a registered source needn't write copy to exist — it lists
   *  under its group name alone. */
  blurb?: string;
  /** `instant` runs on every keystroke and must return synchronously — no IO.
   *  `deferred` is debounced (180ms) and may await. */
  timing: "instant" | "deferred";
  /** Below this query length the source isn't asked. Deferred sources default
   *  to 1: a round trip per keystroke on an empty box helps nobody. */
  minQuery?: number;
  rows: (q: SpotQuery) => SpotRow[] | Promise<SpotRow[]>;
}

const SOURCES: SpotSource[] = [
  { id: "actions", group: "Actions", blurb: "The launcher entries, and running what you typed as a one-shot task.", timing: "instant", rows: (q) => actionRows(q.query, q.ctx, q.attachments) },
  { id: "tabs", group: "Open Tabs", blurb: "Everything open in this project's tab strip.", timing: "instant", rows: (q) => tabRows(q.query, q.ctx) },
  { id: "files", group: "Files", blurb: "File names under the project's components.", timing: "deferred", rows: (q) => fileRows(q.query, q.corpus) },
  { id: "symbols", group: "Symbols", blurb: "Workspace symbols from language servers already running — never starts one.", timing: "deferred", minQuery: 2, rows: (q) => codeSymbolRows(q.query, q.roots) },
  { id: "content", group: "In Files", blurb: "Text inside the project's files (ripgrep, live per query).", timing: "deferred", minQuery: 2, rows: (q) => contentRows(q.query, q.roots) },
  // One source, two sections: the persistent index answers for terminal
  // scrollback and transcripts in the same query.
  { id: "index", group: "Terminal Output", blurb: "The persistent index: every agent's conversations and live terminal scrollback. What it holds is set below.", timing: "deferred", minQuery: 2, rows: (q) => indexRows(q.query, q.ctx, q.roots) },
  { id: "sessions", group: "Agent Sessions", blurb: "Agent sessions by prompt, branch and files touched (from their digests).", timing: "instant", rows: (q) => sessionRows(q.query, q.ctx) },
  // Above tickets and PRs deliberately: if what you are about to go and find
  // out has already been found out, that is the most useful row on the page.
  { id: "research", group: "Research", blurb: "Findings recorded in this project — what was investigated, and what shipped from it.", timing: "instant", rows: (q) => researchRows(q.query, q.ctx.projectId) },
  { id: "tickets", group: "Tickets", blurb: "Issues from the configured trackers. Fetches over the network, cached 60s.", timing: "deferred", rows: (q) => ticketRows(q.query, q.roots) },
  { id: "prs", group: "Pull Requests", blurb: "Open PRs the watcher has already fetched — no round trip here.", timing: "instant", rows: (q) => prRows(q.query) },
  { id: "branches", group: "Branches", blurb: "Branches in this project's repos, local and remote. Enter switches this repo to one.", timing: "deferred", rows: (q) => branchRows(q.query, q.roots) },
  { id: "servers", group: "Servers", blurb: "Every command this project can run, and what's up right now.", timing: "instant", rows: (q) => serverRows(q.query, q.ctx) },
  { id: "tasks", group: "Task History", blurb: "One-shot tasks that have finished, and what they reported.", timing: "instant", rows: (q) => taskRows(q.query, q.ctx) },
];

/** Add a source. Returns the undo — call it when whatever registered the source
 *  goes away, or the palette keeps asking a dead thing for rows. */
export function registerSpotSource(
  source: SpotSource,
  opts: { before?: string } = {},
): () => void {
  const at = opts.before ? SOURCES.findIndex((s) => s.id === opts.before) : -1;
  if (at === -1) SOURCES.push(source);
  else SOURCES.splice(at, 0, source);
  return () => {
    const i = SOURCES.indexOf(source);
    if (i !== -1) SOURCES.splice(i, 1);
  };
}

/** The registry as it stands — for tests and for anything that wants to show
 *  what the palette can search. */
export function spotSources(): readonly SpotSource[] {
  return SOURCES;
}

/** Section order the palette renders in: registration order, deduped. Actions
 *  first, then what's already open, then the progressively-further-away
 *  sources — and whatever was registered after them, after them. */
export function spotGroupOrder(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of SOURCES) {
    // The section a source declares, plus any its rows actually filled and
    // that nothing else claims (the index source's second section).
    if (!seen.has(s.group)) {
      seen.add(s.group);
      out.push(s.group);
    }
  }
  return out;
}

/** Sources the user switched off in Settings → SpotSearch. Read per query
 *  rather than cached: settings are a localStorage read behind a cache, and a
 *  palette that only honours the setting after a restart is a bug report. */
const disabled = (): string[] => {
  try {
    return getSettings().spotDisabledSources;
  } catch {
    return [];
  }
};

const asks = (s: SpotSource, query: string, off: string[]) =>
  !off.includes(s.id) &&
  query.trim().length >= (s.minQuery ?? (s.timing === "deferred" ? 1 : 0));

/** The synchronous sources, on every keystroke. A throwing source costs its own
 *  rows and nothing else. */
export function instantRows(q: SpotQuery): SpotRow[] {
  const out: SpotRow[] = [];
  const off = disabled();
  for (const s of SOURCES) {
    if (s.timing !== "instant" || !asks(s, q.query, off)) continue;
    try {
      const rows = s.rows(q);
      if (Array.isArray(rows)) out.push(...rows);
      else if (import.meta.env?.DEV) {
        console.warn(`[spot] instant source "${s.id}" returned a promise`);
      }
    } catch (err) {
      if (import.meta.env?.DEV) console.warn(`[spot] source "${s.id}" threw`, err);
    }
  }
  return out;
}

/** The debounced ones, all in flight together. */
export async function deferredRows(q: SpotQuery): Promise<SpotRow[]> {
  const off = disabled();
  const lists = await Promise.all(
    SOURCES.filter((s) => s.timing === "deferred" && asks(s, q.query, off)).map((s) =>
      Promise.resolve()
        .then(() => s.rows(q))
        .catch((err) => {
          if (import.meta.env?.DEV) console.warn(`[spot] source "${s.id}" failed`, err);
          return [] as SpotRow[];
        }),
    ),
  );
  return lists.flat();
}

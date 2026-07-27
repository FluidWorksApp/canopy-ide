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
import { getSnapshot as prSnapshot } from "./prWatchStore";
import { toPrInfo } from "./prInbox";

/** What Enter does on a row — ProjectView owns the dispatch, this names it. */
export type SpotAction =
  | { type: "run-task"; brief: string }
  | { type: "new-shell" }
  | { type: "new-preview" }
  | { type: "launch-cli"; cliId: string }
  | { type: "open-file"; path: string; line?: number }
  | { type: "focus-tab"; tabId: string }
  | { type: "open-session"; digest: ipc.SessionDigest }
  | { type: "open-ticket"; source: string; ticket: ipc.TicketInfo }
  | { type: "open-pr"; repo: string; pr: ipc.PrInfo }
  | { type: "open-server"; path: string; tabId: string | null }
  | { type: "open-task-run"; runId: string };

export interface SpotRow {
  id: string;
  /** Section heading the palette groups under. */
  group: string;
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
export function actionRows(query: string, ctx: SpotContext): SpotRow[] {
  const q = query.trim();
  const launchers: { row: SpotRow; hay: string }[] = [
    {
      hay: "new shell terminal",
      row: {
        id: "act:shell",
        group: "Actions",
        icon: ">_",
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
        icon: "○",
        title: "New Preview",
        score: 0,
        action: { type: "new-preview" },
      },
    },
    ...ctx.clis.map((cli) => ({
      hay: `launch agent ${cli.name}`,
      row: {
        id: `act:cli:${cli.id}`,
        group: "Actions",
        icon: "✳",
        title: `New ${cli.name}`,
        score: 0,
        action: { type: "launch-cli", cliId: cli.id } as SpotAction,
      },
    })),
  ];
  const rows = ranked(query, launchers, 4);
  if (q) {
    rows.unshift({
      id: "act:run-task",
      group: "Actions",
      icon: "⚡",
      title: `Run task: “${q}”`,
      detail: "one-shot agent · current page as context",
      score: -1,
      action: { type: "run-task", brief: q },
    });
  }
  return rows;
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
      title: s.name,
      detail: `${s.kind} · ${s.path.slice(s.path.lastIndexOf("/") + 1)}:${s.line}`,
      score: 0,
      action: { type: "open-file", path: s.path, line: s.line } as SpotAction,
    }));
}

/** Hits from the persistent index (transcripts + terminal scrollback), mapped
 *  back to something openable: a terminal hit to its live tab, a transcript hit
 *  to its session digest. A hit whose container is gone is dropped, not shown. */
export async function indexRows(query: string, ctx: SpotContext): Promise<SpotRow[]> {
  if (query.trim().length < 2) return [];
  const hits = await ipc.spotSearch(query, 14).catch(() => []);
  const out: SpotRow[] = [];
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
        title: tabDisplayLabel(tab),
        detail: h.snippet,
        score: 0,
        action: { type: "focus-tab", tabId: tab.id },
      });
    } else {
      const digest = ctx.digests.find((d) => d.session_id === h.key);
      if (!digest) continue;
      out.push({
        id: `spot:${h.kind}:${h.key}`,
        group: "Agent Sessions",
        title: `${digest.agent ?? "agent"}${digest.branch ? ` · ${digest.branch}` : ""}`,
        detail: h.snippet,
        score: 0,
        action: { type: "open-session", digest },
      });
    }
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
        title: `${ticket.id} ${ticket.title}`,
        detail: ticket.state,
        score: 0,
        action: { type: "open-ticket", source, ticket } as SpotAction,
      },
    })),
  );
}

/** Section order the palette renders in — actions first, then what's already
 *  open, then the progressively-further-away sources. */
export const SPOT_GROUP_ORDER = [
  "Actions",
  "Open Tabs",
  "Files",
  "Symbols",
  "In Files",
  "Terminal Output",
  "Agent Sessions",
  "Tickets",
  "Pull Requests",
  "Servers",
  "Task History",
];

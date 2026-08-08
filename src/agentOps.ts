// The agent tools that only the running IDE can answer (canopy_diagnostics,
// canopy_references, canopy_definition, canopy_tickets, canopy_reviews).
//
// Each one exists because the agent's own tools genuinely cannot get there:
// the language server Canopy keeps warm per workspace answers a type-aware
// question in milliseconds where `tsc --noEmit` recompiles the world, and the
// trackers hold a key (Linear) that lives in Canopy's settings and nowhere a
// CLI can reach.
//
// Pure functions over ipc/monaco: App owns the routing and the answering, this
// owns the work.
import * as ipc from "./ipc";
import { runVaultOp, type PreviewTarget } from "./vaultFill";
import { modelFor, monaco } from "./monaco-setup";
import {
  describeMissingServer,
  ensureLanguageServer,
  hasServerFor,
  indexingCeilingMs,
  lspRequest,
  runningServersUnder,
  serverCommandFor,
  whenQuiet,
  workspaceRequest,
} from "./lsp/client";
import { flattenHover, type HoverContents } from "./lsp/hover";
import { sortRows, symbolRows, type SymbolRow } from "./lsp/symbols";
import { positionOf, type LspPosition } from "./lspPosition";
import { TRACKERS } from "./trackers";
import { readBoundedFile } from "./boundedFileRead";
import { sizeLimitFor } from "./fileOpen";
import { rendererIoBudget } from "./ioBudget";

/** How long a first diagnostics call waits for the server to publish. A cold
 *  tsserver is doing real work; a warm one answers in a frame. */
const DIAGNOSTIC_WAIT_MS = 8000;
const MAX_LOCATIONS = 100;
const sourceDecoder = new TextDecoder();
const NETWORK_RESPONSE_ADMISSION_BYTES = 2 * 1024 * 1024;

const runProjectNetwork = <T>(scope: string, operation: () => Promise<T>) =>
  rendererIoBudget.run(
    { scope, bytes: NETWORK_RESPONSE_ADMISSION_BYTES },
    operation,
  );

const readSourceText = async (path: string, scope: string) =>
  sourceDecoder.decode(
    await readBoundedFile(path, {
      scope,
      maxBytes: sizeLimitFor("code"),
    }),
  );

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspLocationLink {
  targetUri: string;
  targetSelectionRange?: LspRange;
  targetRange: LspRange;
}

const rootFor = (path: string, roots: string[]): string | null =>
  roots.find((r) => path === r || path.startsWith(`${r}/`)) ?? roots[0] ?? null;

/** Make sure the file is a live model the language server has been told about.
 *  Opening the model is what triggers didOpen, which is what makes the server
 *  produce diagnostics for a file the user never opened. */
async function prime(path: string, roots: string[]): Promise<{ root: string; text: string }> {
  const root = rootFor(path, roots);
  if (!root) throw new Error(`${path} isn't inside any open Canopy project`);
  const existing = monaco.editor.getModel(monaco.Uri.file(path));
  const text = existing ? existing.getValue() : await readSourceText(path, root);
  modelFor(path, text);
  await ensureLanguageServer(path, root);
  if (!(await hasServerFor(path, root))) {
    throw new Error(await describeMissingServer(path, root));
  }
  return { root, text };
}

const SEVERITY: Record<number, string> = {
  8: "error",
  4: "warning",
  2: "info",
  1: "hint",
};

function markersFor(uri: monaco.Uri) {
  return monaco.editor
    .getModelMarkers({ resource: uri })
    .map((m) => ({
      severity: SEVERITY[m.severity] ?? String(m.severity),
      line: m.startLineNumber,
      column: m.startColumn,
      message: m.message,
      source: m.source ?? null,
      code: typeof m.code === "object" ? m.code?.value : (m.code ?? null),
    }))
    .sort((a, b) => a.line - b.line);
}

export async function diagnostics(
  path: string | null | undefined,
  roots: string[],
  budgetMs?: number | null,
) {
  if (!path) {
    // No file named: report on everything Canopy currently has open. Honest
    // about its own scope — this is not a project-wide typecheck.
    const models = monaco.editor.getModels();
    const files = models
      .map((m) => ({ path: m.uri.path, problems: markersFor(m.uri) }))
      .filter((f) => f.problems.length > 0);
    return {
      scope: "open files",
      files,
      note: files.length
        ? undefined
        : "No problems in the files Canopy has open. Name a path to have it checked.",
    };
  }
  const { root } = await prime(path, roots);
  const uri = monaco.Uri.file(path);
  // A server that indexes before it can answer (rust-analyzer, tens of seconds
  // on a cold crate) gets waited out on its own terms: quiet ends the wait
  // early, and hitting the ceiling is reported rather than dressed up as clean.
  let note: string | undefined;
  const ceiling = indexingCeilingMs(path);
  if (ceiling != null) {
    const budget = budgetMs != null ? Math.min(ceiling, budgetMs) : ceiling;
    if ((await whenQuiet(path, root, budget)) === "busy") {
      note = `${serverCommandFor(path) ?? "the language server"} is still indexing — results may be incomplete.`;
    }
  }
  const before = markersFor(uri);
  // A file that already has markers has been analysed; otherwise wait for the
  // server's first publish rather than reporting a premature all-clear.
  if (before.length === 0) {
    const wait = budgetMs != null ? Math.max(0, budgetMs) : DIAGNOSTIC_WAIT_MS;
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(finish, wait);
      const sub = monaco.editor.onDidChangeMarkers((uris) => {
        if (uris.some((u) => u.toString() === uri.toString())) finish();
      });
      function finish() {
        window.clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  }
  return { path, root, problems: markersFor(uri), note };
}

const pathOfUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));

/** Locations with the line they point at — a bare file:line list makes the
 *  agent open every hit; the line text usually settles it without a read. */
async function describeLocations(locations: LspLocation[], roots: string[]) {
  const cache = new Map<string, string[]>();
  const out = [];
  for (const loc of locations.slice(0, MAX_LOCATIONS)) {
    const path = pathOfUri(loc.uri);
    let lines = cache.get(path);
    if (!lines) {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const text = model
        ? model.getValue()
        : await readSourceText(path, rootFor(path, roots) ?? "agent-ops").catch(
            () => "",
          );
      lines = text.split("\n");
      cache.set(path, lines);
    }
    out.push({
      path,
      line: loc.range.start.line + 1,
      column: loc.range.start.character + 1,
      text: (lines[loc.range.start.line] ?? "").trim().slice(0, 200),
    });
  }
  return out;
}

/** Resolve `path` + (`symbol` | line/column) to a live document and an LSP
 *  position — the addressing every position-based tool shares. */
async function at(op: ipc.AgentUiOp, roots: string[]) {
  const path = op.path as string;
  const { root, text } = await prime(path, roots);
  const position = positionOf(text, op);
  return {
    path,
    root,
    position,
    textDocument: { uri: monaco.Uri.file(path).toString() },
    of: op.symbol ?? `${path}:${position.line + 1}:${position.character + 1}`,
  };
}

async function symbolQuery(
  method: "textDocument/references" | "textDocument/definition",
  op: ipc.AgentUiOp,
  roots: string[],
) {
  const { path, root, position, textDocument, of } = await at(op, roots);
  const result = await lspRequest(path, root, method, {
    textDocument,
    position,
    ...(method === "textDocument/references" ? { context: { includeDeclaration: false } } : {}),
  });
  if (result === null) throw new Error(await describeMissingServer(path, root));
  const raw = (Array.isArray(result) ? result : result ? [result] : []) as (
    | LspLocation
    | LspLocationLink
  )[];
  const locations: LspLocation[] = raw.map((r) =>
    "targetUri" in r
      ? { uri: r.targetUri, range: r.targetSelectionRange ?? r.targetRange }
      : r,
  );
  const found = await describeLocations(locations, roots);
  return {
    of,
    count: locations.length,
    truncated: locations.length > MAX_LOCATIONS,
    locations: found,
  };
}

/** The type signature and docs the editor shows on hover — the answer to "what
 *  is this" that a grep can only guess at. */
async function hover(op: ipc.AgentUiOp, roots: string[]) {
  const { path, root, position, textDocument, of } = await at(op, roots);
  const result = (await lspRequest(path, root, "textDocument/hover", {
    textDocument,
    position,
  })) as { contents?: HoverContents } | null;
  // A server with nothing to say answers null, same as no server at all; only
  // the second is a failure worth throwing over.
  if (result === null && !(await hasServerFor(path, root))) {
    throw new Error(await describeMissingServer(path, root));
  }
  const contents = flattenHover(result?.contents);
  return {
    of,
    path,
    line: position.line + 1,
    column: position.character + 1,
    contents,
    note: contents ? undefined : "The language server has no hover information there.",
  };
}

/** Find a symbol by name across the workspace, or outline one file. The
 *  type-aware answer to "where is X defined", which grep can only approximate
 *  once the name is common enough to appear in prose. */
async function symbols(op: ipc.AgentUiOp, roots: string[]) {
  const query = op.query?.trim();
  if (!query) {
    if (!op.path) throw new Error("canopy_symbols needs a query, or a path to outline");
    const path = op.path;
    const { root } = await prime(path, roots);
    const result = await lspRequest(path, root, "textDocument/documentSymbol", {
      textDocument: { uri: monaco.Uri.file(path).toString() },
    });
    if (result === null) throw new Error(await describeMissingServer(path, root));
    const rows = symbolRows(result, path);
    return {
      scope: path,
      count: rows.length,
      truncated: rows.length > MAX_LOCATIONS,
      symbols: rows.slice(0, MAX_LOCATIONS),
    };
  }

  // Deliberately asks only the servers already running: starting one here would
  // make a name lookup pay for a cold rust-analyzer index the agent never asked
  // for. Nothing running is reported as such, with the cheap way to fix it.
  const rows: SymbolRow[] = [];
  let servers = 0;
  for (const root of roots) {
    servers += runningServersUnder(root).length;
    for (const { result } of await workspaceRequest(root, "workspace/symbol", { query })) {
      rows.push(...symbolRows(result));
    }
  }
  if (servers === 0) {
    return {
      scope: `workspace search for "${query}"`,
      count: 0,
      symbols: [],
      note:
        "No language server is running for this project yet — Canopy starts one when a file " +
        "of that language is opened. Call canopy_diagnostics on a file first, then ask again.",
    };
  }
  const found = sortRows(rows);
  return {
    scope: `workspace search for "${query}"`,
    count: found.length,
    truncated: found.length > MAX_LOCATIONS,
    symbols: found.slice(0, MAX_LOCATIONS),
  };
}

/** Every connected tracker's issues, merged. GitHub an agent could reach with
 *  `gh`; Linear it could not — that key lives in Canopy's settings. */
async function tickets(repos: string[]) {
  const out: { source: string; ticket: ipc.TicketInfo }[] = [];
  const errors: string[] = [];
  for (const provider of TRACKERS) {
    const available = await provider.available(repos);
    if (!available.ok) continue;
    for (const repo of repos) {
      try {
        const list = await runProjectNetwork(repo || provider.id, () =>
          provider.fetch(repo),
        );
        out.push(...list.map((ticket) => ({ source: provider.id, ticket })));
      } catch (err) {
        errors.push(`${provider.name}: ${String(err)}`);
      }
      // Global trackers answer the same list for every repo; asking once is
      // enough (see TrackerProvider.scope).
      if (provider.scope === "global") break;
    }
  }
  return {
    tickets: out.map(({ source, ticket }) => ({
      source,
      id: ticket.id,
      title: ticket.title,
      state: ticket.state,
      assignee: ticket.assignee,
      mine: ticket.mine,
      branch: ticket.branch,
      url: ticket.url,
      priority: ticket.priority,
      body: ticket.body.slice(0, 4000),
    })),
    errors,
  };
}

/** What's waiting on a review: teammates' requests that arrived over the relay
 *  (which exist nowhere but this app) and the repos' open PRs.
 *
 *  `repos` is the calling session's project for a coding agent, and the
 *  workspace's — optionally narrowed by name — for the companion, which is in
 *  no project and would otherwise be asking about an empty set. */
async function reviews(repos: string[], inbox: ipc.RelayCommandMsg[]) {
  const relay = inbox
    .filter((i) => i.kind === "review")
    .map((i) => {
      const p = i.payload as { title?: string; branch?: string; insertions?: number; deletions?: number };
      return {
        from: i.from_name,
        title: p.title ?? "",
        branch: p.branch ?? "",
        insertions: p.insertions ?? 0,
        deletions: p.deletions ?? 0,
        note: "Open it in Canopy's Team panel to read the diff.",
      };
    });
  // In parallel, because this now covers the whole workspace when the caller
  // is in no project: one `gh` call per repo, one after another, is the
  // difference between an answer and a timeout.
  const prs = (
    await Promise.all(
      repos.map(async (repo) => {
        const list = await runProjectNetwork(repo, () => ipc.ghPrList(repo)).catch(
          () => [],
        );
        return list.map((pr) => ({
          repo,
          number: pr.number,
          title: pr.title,
          author: pr.author,
          branch: pr.branch,
          draft: pr.draft,
          mine: pr.mine,
          reviewDecision: pr.review_decision,
          mergeable: pr.mergeable,
          url: pr.url,
        }));
      }),
    )
  ).flat();
  return { relayRequests: relay, pullRequests: prs };
}

/** One project as the companion sees it. Assembled by App, which is the only
 *  thing that knows about projects at all — every other consumer of this file
 *  works in one checkout and has no notion of a workspace. */
export interface WorkspaceProject {
  name: string;
  roots: string[];
  open: boolean;
  hibernated: boolean;
  /** Each component with the run commands Canopy has configured for it.
   *
   *  Carried because without it the companion cannot start anything:
   *  `canopy_start_server` takes a `dir` and the *name* of a configured
   *  command, and an agent that has never been told those names has no way to
   *  guess them. It shelled out to `ls` instead and then told the user to run
   *  the server themselves — which is the whole feature failing on a missing
   *  field. */
  components: { label: string; path: string; commands: string[] }[];
}

export interface UiOpContext {
  roots: string[];
  repos: string[];
  inbox: ipc.RelayCommandMsg[];
  /** Put the question in front of the user and resolve with their answer. */
  ask: (question: string, options: string[]) => Promise<string>;
  /** Every project the user has — the companion's reach. Absent for an
   *  ordinary coding session, which is what makes the workspace ops fail
   *  honestly rather than answering for one project as if it were all of them. */
  workspace?: () => WorkspaceProject[];
  /** Put a proposed action to the user; resolves with what they chose. Only
   *  the companion has a tool that reaches this. */
  confirm?: (proposal: {
    action: string;
    project?: string | null;
    detail?: string | null;
    timeoutMs?: number | null;
  }) => Promise<{ accepted: boolean; note?: string }>;
  /** Bring a project to the front, opening or waking it if need be. */
  openProject?: (name: string, why?: string | null) => Promise<string>;
  /** Search Canopy's own cross-project index. */
  search?: (query: string, limit: number) => Promise<unknown>;
  /** What every coding session in every project is doing. */
  agents?: (project?: string | null) => Promise<unknown>;
  /** Branch/ahead/behind/dirty per repo, across the workspace. */
  workspaceGit?: (project?: string | null) => Promise<unknown>;
  /** Set a coding agent going on a brief, in a component the caller names.
   *  Resolves once Canopy has actually tried — a handoff whose outcome the
   *  caller cannot see is not a handoff. */
  startSession?: (req: {
    project?: string | null;
    dir?: string | null;
    prompt?: string | null;
    label?: string | null;
    agent?: string | null;
  }) => Promise<{ started: boolean; project: string; dir: string; note: string }>;
  /** The preview tab an agent's browser ops are driving, for the vault ops:
   *  filling a credential needs to know which page is being logged in to. */
  preview: () => Promise<PreviewTarget | null>;
}

function companionRepos(
  ctx: UiOpContext,
  project?: string | null,
  tool = "canopy_workspace_prs",
): { project: string; repo: string }[] {
  const projects = needCompanion(ctx.workspace, tool)();
  const wanted = project?.trim().toLowerCase();
  const scoped = wanted ? projects.filter((p) => p.name.toLowerCase() === wanted) : projects;
  if (wanted && scoped.length === 0) {
    throw new Error(`no project called "${project}" — the projects are: ${projects.map((p) => p.name).join(", ")}`);
  }
  const seen = new Set<string>();
  return scoped.flatMap((p) =>
    p.roots.flatMap((repo) => {
      if (seen.has(repo)) return [];
      seen.add(repo);
      return [{ project: p.name, repo }];
    }),
  );
}

async function workspacePrs(ctx: UiOpContext, project?: string | null) {
  const errors: { project: string; repo: string; error: string }[] = [];
  const possiblyTruncatedRepos = new Set<string>();
  const fetched = (
    await Promise.all(
      companionRepos(ctx, project).map(async ({ project: name, repo }) => {
        try {
          const prs = await runProjectNetwork(repo, () => ipc.ghPrList(repo));
          if (prs.length === 50) possiblyTruncatedRepos.add(repo);
          return prs.map((pr) => ({ project: name, repo, ...pr }));
        } catch (err) {
          errors.push({ project: name, repo, error: String(err) });
          return [];
        }
      }),
    )
  ).flat();
  // Several components may be directories inside the same repository. The
  // backend accepts each path and resolves it to the same top-level checkout;
  // fold those duplicate queries on GitHub's stable PR URL before returning.
  const rows = [...new Map(fetched.map((pr) => [pr.url, pr])).values()];
  rows.sort((a, b) => b.updated.localeCompare(a.updated));
  return {
    pullRequests: rows,
    errors,
    limitPerRepo: 50,
    possiblyTruncatedRepos: [...possiblyTruncatedRepos],
  };
}

function checkedCompanionRepo(ctx: UiOpContext, repo: string | null | undefined): string {
  if (!repo) {
    throw new Error("repo is required (use the path returned by canopy_workspace_prs)");
  }
  if (!companionRepos(ctx).some((r) => r.repo === repo)) {
    throw new Error(`${repo} is not a repo in this Canopy workspace`);
  }
  return repo;
}

async function prDetails(op: ipc.AgentUiOp, ctx: UiOpContext) {
  const repo = checkedCompanionRepo(ctx, op.repo);
  if (!op.number) throw new Error("number is required");
  const number = op.number;
  const [body, conversation, reviewers, diff, failingLogs] = await Promise.all([
    runProjectNetwork(repo, () => ipc.ghPrBody(repo, number)),
    runProjectNetwork(repo, () => ipc.ghPrConversation(repo, number)),
    runProjectNetwork(repo, () => ipc.ghPrReviewerCandidates(repo)).catch(() => []),
    op.includeDiff
      ? runProjectNetwork(repo, () => ipc.ghPrDiff(repo, number))
      : Promise.resolve(undefined),
    op.includeLogs
      ? runProjectNetwork(repo, () => ipc.ghPrFailingLogs(repo, number))
      : Promise.resolve(undefined),
  ]);
  return { repo, number, body, conversation, reviewers, diff, failingLogs };
}

async function prAction(op: ipc.AgentUiOp, ctx: UiOpContext) {
  const repo = checkedCompanionRepo(ctx, op.repo);
  const number = op.number;
  if (!number) throw new Error("number is required");
  switch (op.action) {
    case "review":
      if (!op.review) {
        throw new Error("review is required: approve, comment, or request-changes");
      }
      return { result: await ipc.ghPrReview(repo, number, op.review, op.body ?? undefined) };
    case "request_review":
      if (!op.reviewers?.length) throw new Error("reviewers is required");
      return { result: await ipc.ghPrRequestReview(repo, number, op.reviewers) };
    case "reply":
      if (!op.threadId || !op.body?.trim()) throw new Error("threadId and body are required");
      return { result: await ipc.ghPrThreadReply(repo, op.threadId, op.body) };
    case "resolve":
      if (!op.threadId || op.resolved == null) throw new Error("threadId and resolved are required");
      return { result: await ipc.ghPrThreadResolved(repo, op.threadId, op.resolved) };
    case "update_branch":
      return { result: await ipc.ghPrUpdateBranch(repo, number) };
    case "auto_merge":
      return {
        result: await ipc.ghPrAutoMerge(
          repo,
          number,
          op.method ?? "squash",
          op.enable ?? true,
        ),
      };
    case "merge":
      return { result: await ipc.ghPrMerge(repo, number, op.method ?? "squash") };
    case "ready":
      return { result: await ipc.ghPrReady(repo, number) };
    case "close":
      return { result: await ipc.ghPrClose(repo, number, op.deleteBranch ?? false) };
    default:
      throw new Error(
        "action must be review, request_review, reply, resolve, update_branch, auto_merge, merge, ready, or close",
      );
  }
}

/** Just the companion's half of the context. App builds exactly this set when
 *  the companion is on, and nothing when it is off — which is what makes the
 *  workspace ops fail honestly for a coding session. */
export type CompanionOps = Required<
  Pick<
    UiOpContext,
    | "workspace"
    | "confirm"
    | "openProject"
    | "search"
    | "agents"
    | "workspaceGit"
    | "startSession"
  >
>;

/** The companion's handlers are optional on the context, because every other
 *  caller of this file is a coding session that has no workspace to speak of.
 *  A missing one is a real condition worth naming rather than a crash. */
function needCompanion<T>(handler: T | undefined, tool: string): T {
  if (!handler) {
    throw new Error(
      `${tool} is only available to Canopy's companion, and this session is not it`,
    );
  }
  return handler;
}

/** Run one UI op and produce the tool's result. Throwing is how an op reports
 *  a problem the agent should read — App turns it into the error payload. */
export async function runUiOp(op: ipc.AgentUiOp, ctx: UiOpContext): Promise<unknown> {
  switch (op.op) {
    case "diagnostics":
      return diagnostics(op.path, ctx.roots, op.waitMs);
    case "references":
      return symbolQuery("textDocument/references", op, ctx.roots);
    case "definition":
      return symbolQuery("textDocument/definition", op, ctx.roots);
    case "hover":
      return hover(op, ctx.roots);
    case "symbols":
      return symbols(op, ctx.roots);
    case "tickets":
      return tickets(ctx.repos);
    case "reviews":
      // A session inside a project asks about that project. The companion is
      // inside none, so its `ctx.repos` is empty — and answering "nothing is
      // waiting on you" from an empty repo list is the most misleading thing
      // this tool could do. Fall through to the workspace it can actually see.
      return reviews(
        ctx.repos.length || !ctx.workspace
          ? ctx.repos
          : companionRepos(ctx, op.project, "canopy_reviews").map((r) => r.repo),
        ctx.inbox,
      );
    case "ask":
      return { answer: await ctx.ask(op.question ?? "", op.options ?? []) };
    case "vault":
      return runVaultOp(op, { preview: ctx.preview, ask: ctx.ask });

    // ---- the companion's cross-project ops ----
    //
    // The sidecar already refuses these outside a companion session, so
    // reaching here without the handler means the app is running a build whose
    // front end predates the tool. Saying so beats answering for one project as
    // though it were the whole workspace.
    case "workspace":
      return {
        projects: needCompanion(ctx.workspace, "canopy_workspace")(),
        note:
          "Each component lists the run commands Canopy has configured. Start one " +
          "with canopy_start_server({ dir, command }) using the component's path and " +
          "the command's name — do not run it through the shell.",
      };
    case "workspace_git":
      return needCompanion(ctx.workspaceGit, "canopy_workspace_git")(op.project);
    case "workspace_agents":
      return needCompanion(ctx.agents, "canopy_workspace_agents")(op.project);
    case "workspace_search":
      return needCompanion(ctx.search, "canopy_workspace_search")(
        op.query ?? "",
        Math.min(Math.max(op.limit ?? 20, 1), 100),
      );
    case "workspace_prs":
      return workspacePrs(ctx, op.project);
    case "start_session":
      return needCompanion(ctx.startSession, "canopy_start_session")({
        project: op.project,
        dir: op.dir,
        prompt: op.prompt,
        label: op.label,
        agent: op.agent,
      });
    case "pr_details":
      return prDetails(op, ctx);
    case "pr_action":
      return prAction(op, ctx);
    case "open_project": {
      const opened = await needCompanion(ctx.openProject, "canopy_open_project")(
        op.project ?? "",
        op.why,
      );
      return { opened, note: "The user is now looking at this project." };
    }
    case "confirm": {
      const answer = await needCompanion(ctx.confirm, "canopy_confirm")({
        action: op.action ?? "",
        project: op.project,
        detail: op.detail,
        timeoutMs: op.timeoutMs,
      });
      return {
        accepted: answer.accepted,
        note: answer.accepted
          ? "Go ahead — do exactly what you described and nothing more."
          : "The user declined. This is an answer, not an error: say so plainly and stop.",
        ...(answer.note ? { theySaid: answer.note } : {}),
      };
    }
    case "recall": {
      const { loadMemories, recallFrom } = await import("./companionMemory");
      const found = recallFrom(await loadMemories(), op.query);
      return {
        memories: found.map((m) => ({
          about: m.about,
          fact: m.fact,
          when: new Date(m.ts).toISOString().slice(0, 10),
        })),
        note: found.length
          ? undefined
          : "Nothing recorded yet — this is a companion that has not learned anything about them so far.",
      };
    }
    case "remember": {
      const { remember } = await import("./companionMemory");
      const result = await remember({
        fact: op.fact ?? "",
        about: op.about,
        forget: op.forget,
      });
      return result;
    }

    default:
      throw new Error(`unknown op: ${op.op}`);
  }
}

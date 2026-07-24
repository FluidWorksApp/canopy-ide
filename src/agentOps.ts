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
import { modelFor, monaco } from "./monaco-setup";
import { ensureLanguageServer, lspRequest } from "./lsp/client";
import { positionOf, type LspPosition } from "./lspPosition";
import { TRACKERS } from "./trackers";

/** How long a first diagnostics call waits for the server to publish. A cold
 *  tsserver is doing real work; a warm one answers in a frame. */
const DIAGNOSTIC_WAIT_MS = 8000;
const MAX_LOCATIONS = 100;

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
  const text = existing ? existing.getValue() : await ipc.fsReadText(path);
  modelFor(path, text);
  await ensureLanguageServer(path, root);
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

export async function diagnostics(path: string | null | undefined, roots: string[]) {
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
  const before = markersFor(uri);
  // A file that already has markers has been analysed; otherwise wait for the
  // server's first publish rather than reporting a premature all-clear.
  if (before.length === 0) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(finish, DIAGNOSTIC_WAIT_MS);
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
  return { path, root, problems: markersFor(uri) };
}

const pathOfUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));

/** Locations with the line they point at — a bare file:line list makes the
 *  agent open every hit; the line text usually settles it without a read. */
async function describeLocations(locations: LspLocation[]) {
  const cache = new Map<string, string[]>();
  const out = [];
  for (const loc of locations.slice(0, MAX_LOCATIONS)) {
    const path = pathOfUri(loc.uri);
    let lines = cache.get(path);
    if (!lines) {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const text = model ? model.getValue() : await ipc.fsReadText(path).catch(() => "");
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

async function symbolQuery(
  method: "textDocument/references" | "textDocument/definition",
  op: ipc.AgentUiOp,
  roots: string[],
) {
  const path = op.path as string;
  const { root, text } = await prime(path, roots);
  const position = positionOf(text, op);
  const result = await lspRequest(path, root, method, {
    textDocument: { uri: monaco.Uri.file(path).toString() },
    position,
    ...(method === "textDocument/references" ? { context: { includeDeclaration: false } } : {}),
  });
  if (result === null) {
    throw new Error(
      `No language server covers ${path} — Canopy runs one for TypeScript/JavaScript so far.`,
    );
  }
  const raw = (Array.isArray(result) ? result : result ? [result] : []) as (
    | LspLocation
    | LspLocationLink
  )[];
  const locations: LspLocation[] = raw.map((r) =>
    "targetUri" in r
      ? { uri: r.targetUri, range: r.targetSelectionRange ?? r.targetRange }
      : r,
  );
  const found = await describeLocations(locations);
  return {
    of: op.symbol ?? `${path}:${position.line + 1}:${position.character + 1}`,
    count: locations.length,
    truncated: locations.length > MAX_LOCATIONS,
    locations: found,
  };
}

/** Every connected tracker's issues, merged. GitHub an agent could reach with
 *  `gh`; Linear it could not — that key lives in Canopy's settings. */
async function tickets(repos: string[]) {
  const out: { source: string; ticket: ipc.TicketInfo }[] = [];
  const errors: string[] = [];
  await Promise.all(
    TRACKERS.map(async (provider) => {
      const available = await provider.available(repos);
      if (!available.ok) return;
      for (const repo of repos) {
        try {
          const list = await provider.fetch(repo);
          out.push(...list.map((ticket) => ({ source: provider.id, ticket })));
        } catch (err) {
          errors.push(`${provider.name}: ${String(err)}`);
        }
        // Global trackers answer the same list for every repo; asking once is
        // enough (see TrackerProvider.scope).
        if (provider.scope === "global") break;
      }
    }),
  );
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
 *  (which exist nowhere but this app) and the repos' open PRs. */
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
  const prs: unknown[] = [];
  for (const repo of repos) {
    const list = await ipc.ghPrList(repo).catch(() => []);
    prs.push(
      ...list.map((pr) => ({
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
      })),
    );
  }
  return { relayRequests: relay, pullRequests: prs };
}

export interface UiOpContext {
  roots: string[];
  repos: string[];
  inbox: ipc.RelayCommandMsg[];
  /** Put the question in front of the user and resolve with their answer. */
  ask: (question: string, options: string[]) => Promise<string>;
}

/** Run one UI op and produce the tool's result. Throwing is how an op reports
 *  a problem the agent should read — App turns it into the error payload. */
export async function runUiOp(op: ipc.AgentUiOp, ctx: UiOpContext): Promise<unknown> {
  switch (op.op) {
    case "diagnostics":
      return diagnostics(op.path, ctx.roots);
    case "references":
      return symbolQuery("textDocument/references", op, ctx.roots);
    case "definition":
      return symbolQuery("textDocument/definition", op, ctx.roots);
    case "tickets":
      return tickets(ctx.repos);
    case "reviews":
      return reviews(ctx.repos, ctx.inbox);
    case "ask":
      return { answer: await ctx.ask(op.question ?? "", op.options ?? []) };
    default:
      throw new Error(`unknown op: ${op.op}`);
  }
}

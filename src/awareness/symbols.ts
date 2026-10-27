// Symbol-level overlap.
//
// Two agents can collide without touching the same file: one renames
// `priceFor` in checkout.ts while the other is writing cart.ts, which calls
// it. Paths never meet; the symbol does. So: pull the identifiers a turn's
// edits declared (before or after) and find the files that use each.
//
//  * A name the turn removed or renamed away no longer has a declaration, so
//    no language server can resolve it; the files still calling it are found
//    by a whole-word text search of the project (fs_search). Those callers are
//    the likeliest breakage, so removed names come first.
//  * A name that still exists asks a language server for its references. One
//    already running answers at once; when none is, one is started on demand
//    through the existing LSP client, within a time budget — and if it can't
//    answer inside it, the text search stands in.
//
// Never throws: a note we cannot back is better left unsent.

/** The journal's view of one edit (ipc.AgentEdit, minus what we don't need). */
export interface EditText {
  path: string;
  old: string | null;
  new: string | null;
}

export interface ChangedIdentifier {
  symbol: string;
  /** The file it was declared in (as the edit named it). */
  path: string;
  /** Declared before the edit and gone after it: removed or renamed away. */
  removed: boolean;
}

const DECLS: RegExp[] = [
  // TS/JS: export function/const/class/interface/type/enum NAME
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  // Rust: pub fn/struct/enum/trait/type/const/static NAME
  /\bpub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)/g,
  // Python: top-level def/class NAME
  /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm,
];

/** Declarations that aren't exported — a method, a module-level helper, a Go
 *  func. Only a *removed* one of these counts: its old callers are what break
 *  on a rename, wherever it was visible from. */
const LOCAL_DECLS: RegExp[] = [
  /\b(?:function\*?|def|fn|func|class|interface|struct|trait|enum)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{=;]+)?\{/gm,
];

const NOT_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "constructor", "super", "this",
  "new", "else", "do", "try", "with", "await", "yield", "typeof", "main", "init", "test", "it", "describe",
]);

/** At most this many symbols are looked up per turn. */
export const MAX_SYMBOLS = 6;

function names(text: string | null, patterns: RegExp[]): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name && name.length >= 3 && !NOT_NAMES.has(name)) out.add(name);
    }
  }
  return out;
}

const wordIn = (name: string, text: string | null) =>
  !!text && new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(text);

/** Identifiers declared in the old or new text of edits that actually changed
 *  something, removed/renamed-away names first (callers of a name that no
 *  longer exists are the likeliest breakage). */
export function changedIdentifiers(edits: readonly EditText[]): ChangedIdentifier[] {
  const removed: ChangedIdentifier[] = [];
  const kept: ChangedIdentifier[] = [];
  const seen = new Set<string>();
  for (const e of edits) {
    if ((e.old ?? "") === (e.new ?? "")) continue;
    const before = names(e.old, DECLS);
    const after = names(e.new, DECLS);
    for (const symbol of before) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      if (after.has(symbol)) kept.push({ symbol, path: e.path, removed: false });
      else removed.push({ symbol, path: e.path, removed: true });
    }
    for (const symbol of after) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      kept.push({ symbol, path: e.path, removed: false });
    }
    // A non-exported declaration that disappeared (and isn't used in the new
    // text at all) was renamed or deleted: its old callers break too.
    for (const symbol of names(e.old, LOCAL_DECLS)) {
      if (seen.has(symbol) || wordIn(symbol, e.new)) continue;
      seen.add(symbol);
      removed.push({ symbol, path: e.path, removed: true });
    }
  }
  return [...removed, ...kept].slice(0, MAX_SYMBOLS);
}

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number } };
}

const pathOfUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));

/** The slice of the LSP client this uses, injectable for tests. */
export interface LspAccess {
  runningServersUnder(root: string): { id: string; serverRoot: string }[];
  ensureLanguageServer?(path: string, root: string): Promise<void>;
  workspaceRequest(root: string, method: string, params: unknown): Promise<{ id: string; result: unknown }[]>;
  lspRequest(path: string, root: string, method: string, params: unknown): Promise<unknown | null>;
}

/** Text search over the project, as fs_search answers it. */
export type TextSearch = (roots: string[], query: string, limit?: number) => Promise<{ path: string; line: number; text: string }[]>;

export interface ReferenceOptions {
  lsp?: LspAccess;
  search?: TextSearch;
  /** How long an on-demand language server may take to start. */
  startBudgetMs?: number;
  /** False in a cloud workspace: no starting servers from the turn path. */
  canStart?: boolean;
}

/** An on-demand start gets this long before the text search stands in. */
export const LSP_START_BUDGET_MS = 8000;
const SEARCH_LIMIT = 400;
const MAX_FILES_PER_SYMBOL = 40;

async function defaultLsp(): Promise<LspAccess> {
  // Lazy: the client pulls in Monaco, which the turn-end path has no business
  // loading in a window that never opened an editor.
  return import("../lsp/client");
}

async function defaultSearch(): Promise<TextSearch> {
  return (await import("../ipc")).fsSearch;
}

const join = (root: string, path: string) =>
  /^([A-Za-z]:)?[\\/]/.test(path) ? path : `${root.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
const same = (a: string, b: string) => a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Whole-word, case-sensitive uses of `symbol` under `root`, outside the file
 *  that declared it. fs_search matches a case-insensitive substring, so each
 *  hit's line is checked again here. */
async function textReferences(root: string, id: ChangedIdentifier, search: TextSearch): Promise<string[]> {
  const hits = await search([root], id.symbol, SEARCH_LIMIT).catch(() => []);
  const declared = id.path ? join(root, id.path) : "";
  const files = new Set<string>();
  for (const h of hits) {
    if (!wordIn(id.symbol, h.text) || (declared && same(h.path, declared))) continue;
    files.add(h.path);
    if (files.size >= MAX_FILES_PER_SYMBOL) break;
  }
  return [...files];
}

/** Ask the language server for references of a name that still exists. Null
 *  when no server could answer for it. */
async function lspReferences(root: string, symbol: string, client: LspAccess): Promise<string[] | null> {
  const hits = await client.workspaceRequest(root, "workspace/symbol", { query: symbol });
  const decl = hits
    .flatMap((h) => (Array.isArray(h.result) ? h.result : []))
    .find(
      (s): s is { name: string; location: LspLocation } =>
        !!s && typeof s === "object" && (s as { name?: unknown }).name === symbol &&
        !!(s as { location?: { uri?: unknown } }).location?.uri,
    );
  if (!decl) return null;
  const path = pathOfUri(decl.location.uri);
  const refs = await client
    .lspRequest(path, root, "textDocument/references", {
      textDocument: { uri: decl.location.uri },
      position: decl.location.range.start,
      context: { includeDeclaration: false },
    })
    .catch(() => null);
  if (!Array.isArray(refs)) return null;
  const files = new Set<string>();
  for (const r of refs as (LspLocation | { targetUri: string })[]) {
    const uri = "targetUri" in r ? r.targetUri : r.uri;
    if (typeof uri === "string") files.add(pathOfUri(uri));
  }
  files.delete(path);
  return [...files];
}

/** Absolute paths of files using each changed identifier. A bare name is
 *  taken as one that still exists. Never throws. */
export async function referenceFiles(
  root: string,
  identifiers: readonly (ChangedIdentifier | string)[],
  opts: ReferenceOptions = {},
): Promise<{ symbol: string; files: string[] }[]> {
  const ids: ChangedIdentifier[] = identifiers.map((i) =>
    typeof i === "string" ? { symbol: i, path: "", removed: false } : i,
  );
  if (!ids.length) return [];
  const out: { symbol: string; files: string[] }[] = [];
  try {
    const search = opts.search ?? (await defaultSearch().catch(() => null));
    let client: LspAccess | null = null;
    if (ids.some((i) => !i.removed)) {
      client = opts.lsp ?? (await defaultLsp().catch(() => null));
      // Nothing serving this project yet: start one on demand for the file
      // the first live name is declared in, within the budget.
      if (client && !client.runningServersUnder(root).length) {
        const first = ids.find((i) => !i.removed && i.path);
        if (first && opts.canStart !== false && client.ensureLanguageServer) {
          await withinBudget(
            client.ensureLanguageServer(join(root, first.path), root),
            opts.startBudgetMs ?? LSP_START_BUDGET_MS,
          ).catch(() => undefined);
        }
        if (!client.runningServersUnder(root).length) client = null;
      }
    }
    for (const id of ids) {
      let files: string[] | null = null;
      if (!id.removed && client) files = await lspReferences(root, id.symbol, client).catch(() => null);
      if (files === null && search) files = await textReferences(root, id, search);
      if (files?.length) out.push({ symbol: id.symbol, files });
    }
    return out;
  } catch {
    return out;
  }
}

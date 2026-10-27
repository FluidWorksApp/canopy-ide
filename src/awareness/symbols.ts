// Symbol-level overlap, the cheap version.
//
// Two agents can collide without touching the same file: one renames
// `priceFor` in checkout.ts while the other is writing cart.ts, which calls
// it. Paths never meet; the symbol does. So: pull the exported identifiers a
// turn's edits declared (before or after), and ask a language server that is
// *already running* for the files that reference each. No server running, or
// any error: skip silently — a note we cannot back is better left unsent than
// a cold rust-analyzer started on the person's machine for it.

/** The journal's view of one edit (ipc.AgentEdit, minus what we don't need). */
export interface EditText {
  path: string;
  old: string | null;
  new: string | null;
}

const DECLS: RegExp[] = [
  // TS/JS: export function/const/class/interface/type/enum NAME
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  // Rust: pub fn/struct/enum/trait/type/const/static NAME
  /\bpub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)/g,
  // Python: top-level def/class NAME
  /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm,
];

/** At most this many symbols are looked up per turn. */
export const MAX_SYMBOLS = 6;

/** Exported identifiers declared in the old or new text of edits that
 *  actually changed something, renamed-away names first (callers of a name
 *  that no longer exists are the likeliest breakage). */
export function changedIdentifiers(edits: readonly EditText[]): { symbol: string; path: string }[] {
  const removed: { symbol: string; path: string }[] = [];
  const kept: { symbol: string; path: string }[] = [];
  const seen = new Set<string>();
  const names = (text: string | null) => {
    const out = new Set<string>();
    if (!text) return out;
    for (const re of DECLS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) out.add(m[1]);
    }
    return out;
  };
  for (const e of edits) {
    if ((e.old ?? "") === (e.new ?? "")) continue;
    const before = names(e.old);
    const after = names(e.new);
    for (const symbol of before) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      (after.has(symbol) ? kept : removed).push({ symbol, path: e.path });
    }
    for (const symbol of after) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      kept.push({ symbol, path: e.path });
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
  workspaceRequest(root: string, method: string, params: unknown): Promise<{ id: string; result: unknown }[]>;
  lspRequest(path: string, root: string, method: string, params: unknown): Promise<unknown | null>;
}

async function defaultLsp(): Promise<LspAccess> {
  // Lazy: the client pulls in Monaco, which the turn-end path has no business
  // loading in a window that never opened an editor.
  return import("../lsp/client");
}

/** Absolute paths of files referencing each symbol, from servers already
 *  running under `root`. Empty when none is running; never throws. */
export async function referenceFiles(
  root: string,
  symbols: readonly string[],
  lsp?: LspAccess,
): Promise<{ symbol: string; files: string[] }[]> {
  if (!symbols.length) return [];
  try {
    const client = lsp ?? (await defaultLsp());
    if (!client.runningServersUnder(root).length) return [];
    const out: { symbol: string; files: string[] }[] = [];
    for (const symbol of symbols) {
      const hits = await client.workspaceRequest(root, "workspace/symbol", { query: symbol });
      const decl = hits
        .flatMap((h) => (Array.isArray(h.result) ? h.result : []))
        .find(
          (s): s is { name: string; location: LspLocation } =>
            !!s && typeof s === "object" && (s as { name?: unknown }).name === symbol &&
            !!(s as { location?: { uri?: unknown } }).location?.uri,
        );
      if (!decl) continue;
      const path = pathOfUri(decl.location.uri);
      const refs = await client
        .lspRequest(path, root, "textDocument/references", {
          textDocument: { uri: decl.location.uri },
          position: decl.location.range.start,
          context: { includeDeclaration: false },
        })
        .catch(() => null);
      if (!Array.isArray(refs)) continue;
      const files = new Set<string>();
      for (const r of refs as (LspLocation | { targetUri: string })[]) {
        const uri = "targetUri" in r ? r.targetUri : r.uri;
        if (typeof uri === "string") files.add(pathOfUri(uri));
      }
      files.delete(path);
      if (files.size) out.push({ symbol, files: [...files] });
    }
    return out;
  } catch {
    return [];
  }
}

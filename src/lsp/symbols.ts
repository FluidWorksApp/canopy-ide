// Symbol results, flattened and named. Two LSP replies answer "where is X":
// workspace/symbol returns a flat SymbolInformation list, documentSymbol a
// nested DocumentSymbol tree (or, from older servers, the flat list again).
// Both become the same rows. Pure, so it tests without Monaco.

/** SymbolKind is wire numbers; an agent reading "12" learns nothing. */
const KINDS = [
  "file", "module", "namespace", "package", "class", "method", "property",
  "field", "constructor", "enum", "interface", "function", "variable",
  "constant", "string", "number", "boolean", "array", "object", "key", "null",
  "enum member", "struct", "event", "operator", "type parameter",
];

export const kindName = (kind: number | undefined): string =>
  KINDS[(kind ?? 0) - 1] ?? "symbol";

interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}

/** workspace/symbol, and what older servers answer for documentSymbol. */
export interface SymbolInformation {
  name: string;
  kind?: number;
  containerName?: string;
  location: { uri: string; range: Range };
}
/** textDocument/documentSymbol from a server that speaks the newer shape. */
export interface DocumentSymbol {
  name: string;
  kind?: number;
  detail?: string;
  range: Range;
  selectionRange?: Range;
  children?: DocumentSymbol[];
}

export interface SymbolRow {
  path: string;
  line: number;
  name: string;
  kind: string;
  /** The enclosing class/module, when the server said — `Foo.bar` is a
   *  different answer from a bare `bar`. */
  container?: string;
}

const pathOfUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));

const isDocumentSymbol = (s: unknown): s is DocumentSymbol =>
  !!s && typeof s === "object" && "range" in (s as object) && !("location" in (s as object));

/** Flatten either reply into rows, walking a DocumentSymbol tree depth-first so
 *  a class's methods follow the class rather than being lost with it. */
export function symbolRows(result: unknown, path?: string): SymbolRow[] {
  const rows: SymbolRow[] = [];
  const walk = (nodes: unknown[], container?: string) => {
    for (const node of nodes) {
      if (isDocumentSymbol(node)) {
        rows.push({
          path: path ?? "",
          line: (node.selectionRange ?? node.range).start.line + 1,
          name: node.name,
          kind: kindName(node.kind),
          ...(container ? { container } : {}),
        });
        if (node.children?.length) walk(node.children, node.name);
      } else {
        const s = node as SymbolInformation;
        if (!s?.name || !s.location?.uri) continue;
        rows.push({
          path: pathOfUri(s.location.uri),
          line: s.location.range.start.line + 1,
          name: s.name,
          kind: kindName(s.kind),
          ...(s.containerName ? { container: s.containerName } : {}),
        });
      }
    }
  };
  walk(Array.isArray(result) ? result : result ? [result] : []);
  return rows;
}

/** Same order every call, so a repeated query doesn't look like it moved:
 *  by file, then by position. */
export function sortRows(rows: SymbolRow[]): SymbolRow[] {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

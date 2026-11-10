// Quick Open (Cmd+P) and Find in Files (Cmd+Shift+F), VS Code-style: one
// overlay, two modes. The file corpus is fetched once per open and filtered
// client-side; content search round-trips to Rust (debounced) since it has to
// read files.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import {explicitFilePaths} from '../explicitFilePaths';
import { pathScore } from "../fuzzy";
import { useEscapeLayer } from "../useEscape";

export type PaletteMode = "files" | "search";

interface PaletteProps {
  mode: PaletteMode;
  /** All of the project's components. Both modes search every component by
   *  default; the scope chips narrow to one. */
  components: { label: string; path: string }[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

interface Row {
  path: string;
  line?: number;
  text?: string;
}

/** The files under each root, listed independently and merged in root order.
 *  Exported for tests. A root that fails contributes nothing. */
export async function listComponentFiles(
  roots: string[],
  list: (roots: string[], limit?: number) => Promise<string[]> = ipc.fsListFiles,
): Promise<string[]> {
  if (roots.length <= 1) return list(roots).catch(() => []);
  const results = await Promise.all(
    roots.map((root) => list([root], PER_ROOT_LIMIT).catch(() => [] as string[])),
  );
  return [...new Set(results.flat())];
}

/** Each component's own budget when several are searched at once. */
const PER_ROOT_LIMIT = 12_000;

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function Palette({ mode, components, onOpen, onClose }: PaletteProps) {
  // Escape is the palette's own, all the way down to the panel behind it —
  // and never the terminal's, wherever focus is. The input's own Escape
  // handling still runs first while it has focus.
  useEscapeLayer(true, { onEscape: () => onClose() });
  const [query, setQuery] = useState("");
  // null = every component (the default)
  const [scope, setScope] = useState<string | null>(null);
  const roots = scope ? [scope] : components.map((c) => c.path);

  /** Which component a result belongs to — the deepest matching root, so
   *  nested components don't all report the outermost one. */
  const componentOf = (path: string) =>
    components
      .filter((c) => path === c.path || path.startsWith(c.path + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0]?.label;

  /** Path shown under a result, relative to its component. */
  const relative = (path: string) => {
    const c = components
      .filter((p) => path.startsWith(p.path + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return c ? path.slice(c.path.length + 1) : path;
  };
  const [files, setFiles] = useState<string[]>([]);
  const [explicitFiles, setExplicitFiles] = useState<string[]>([]);
  const [hits, setHits] = useState<ipc.SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== "files") return;
    // One call per component, so a component that cannot be listed (outside
    // the workspace scope, missing, or so large it uses the whole budget)
    // never hides the others. A single call over every root failed as a unit
    // and the catch showed that as "No results".
    let stale = false;
    void listComponentFiles(roots).then((all) => {
      if (!stale) setFiles(all);
    });
    return () => {
      stale = true;
    };
  }, [mode, roots.join("\n")]);
  useEffect(() => {
    let stopped = false;
    setExplicitFiles([]);
    if (mode !== 'files') return;
    const timer = setTimeout(() => void explicitFilePaths(query, roots).then(files => { if (!stopped) setExplicitFiles(files); }), 150);
    return () => { stopped = true; clearTimeout(timer); };
  }, [mode, query, roots.join('\n')]);

  // Content search is the expensive one — debounce and drop stale responses.
  useEffect(() => {
    if (mode !== "search") return;
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      void ipc
        .fsSearch(roots, query)
        .then((r) => !cancelled && setHits(r))
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setBusy(false));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
      setBusy(false);
    };
  }, [mode, query, roots.join("\n")]);

  const rows: Row[] = useMemo(() => {
    if (mode === "search") return hits;
    return [...new Set([...explicitFiles, ...files])]
      .map((p) => ({ p, s: pathScore(query, p, base(p)) }))
      .filter((r): r is { p: string; s: number } => r.s !== null)
      .sort((a, b) => a.s - b.s || a.p.length - b.p.length)
      .slice(0, 100)
      .map((r) => ({ path: r.p }));
  }, [mode, files, explicitFiles, hits, query]);

  useEffect(() => setSel(0), [query, mode]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".palette-row-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const commit = (row: Row | undefined) => {
    if (!row) return;
    onOpen(row.path);
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={mode === "files" ? "Go to file…" : "Find in files…"}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(rows[sel]);
            }
          }}
        />
        {components.length > 1 && (
          <div className="palette-scopes">
            <button
              className={`palette-scope ${scope === null ? "palette-scope-on" : ""}`}
              onClick={() => setScope(null)}
            >
              All components
            </button>
            {components.map((c) => (
              <button
                key={c.path}
                className={`palette-scope ${scope === c.path ? "palette-scope-on" : ""}`}
                title={c.path}
                onClick={() => setScope(scope === c.path ? null : c.path)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="palette-empty">
              {busy
                ? "Searching…"
                : mode === "search" && query.trim().length < 2
                  ? "Type at least 2 characters"
                  : "No results"}
            </div>
          )}
          {rows.map((r, i) => (
            <div
              key={`${r.path}:${r.line ?? i}`}
              className={`palette-row ${i === sel ? "palette-row-active" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => commit(r)}
            >
              <span className="palette-name">{base(r.path)}</span>
              {r.line != null && <span className="palette-line">:{r.line}</span>}
              {/* Which component this result came from — without it, results
                  from several components are indistinguishable. */}
              {components.length > 1 && componentOf(r.path) && (
                <span className="palette-component">{componentOf(r.path)}</span>
              )}
              {r.text != null ? (
                <span className="palette-snippet">{r.text.trim()}</span>
              ) : (
                <span className="palette-dir">{relative(r.path)}</span>
              )}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            {mode === "files" ? "Quick Open" : "Find in Files"}
            {scope ? ` · ${componentOf(scope) ?? "component"}` : " · all components"}
          </span>
          <span>↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  );
}

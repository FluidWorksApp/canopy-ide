// Quick Open (Cmd+P) and Find in Files (Cmd+Shift+F), VS Code-style: one
// overlay, two modes. The file corpus is fetched once per open and filtered
// client-side; content search round-trips to Rust (debounced) since it has to
// read files.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";

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

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Subsequence match with a light score: earlier and tighter runs rank higher.
 *  Enough for quick-open; deliberately not a full fuzzy-finder. */
function fuzzy(needle: string, hay: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let score = 0;
  let hi = 0;
  let last = -1;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    score += found === last + 1 ? 0 : found - hi + 1;
    last = found;
    hi = found + 1;
  }
  return score;
}

export function Palette({ mode, components, onOpen, onClose }: PaletteProps) {
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
    void ipc.fsListFiles(roots).then(setFiles).catch(() => setFiles([]));
  }, [mode, roots.join("\n")]);

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
    return files
      .map((p) => ({ p, s: fuzzy(query, base(p)) ?? fuzzy(query, p) }))
      .filter((r): r is { p: string; s: number } => r.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 100)
      .map((r) => ({ path: r.p }));
  }, [mode, files, hits, query]);

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

// SpotSearch (Cmd/Ctrl+K): the omnibox. One input over every kind of thing
// Canopy knows — open tabs, files, file contents, symbols, terminal output,
// agent conversations, tickets, PRs, servers, task history — plus the launcher
// actions, and always the option to run what you typed as a one-shot agent
// task with the page behind the palette as context.
//
// Same overlay shape and classes as Quick Open and the ⌘N launcher, on
// purpose: three palettes that look alike are one thing to learn. Cheap
// sources answer on every keystroke; the expensive ones (content search,
// symbols, the persistent index, trackers) are debounced and merge in when
// they land, without reordering what's already under the cursor.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  actionRows,
  codeSymbolRows,
  contentRows,
  fileRows,
  indexRows,
  prRows,
  serverRows,
  sessionRows,
  SPOT_GROUP_ORDER,
  tabRows,
  taskRows,
  ticketRows,
  type SpotAction,
  type SpotContext,
  type SpotRow,
} from "../spotSources";

interface SpotSearchProps {
  ctx: SpotContext;
  onAction: (action: SpotAction) => void;
  onClose: () => void;
}

/** Flatten grouped rows into the render list: a non-selectable header before
 *  each group, in the fixed section order. */
function sectioned(rows: SpotRow[]): (SpotRow | { header: string })[] {
  const byGroup = new Map<string, SpotRow[]>();
  for (const r of rows) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }
  const out: (SpotRow | { header: string })[] = [];
  for (const g of SPOT_GROUP_ORDER) {
    const list = byGroup.get(g);
    if (!list?.length) continue;
    out.push({ header: g });
    out.push(...list.sort((a, b) => a.score - b.score));
  }
  return out;
}

export function SpotSearch({ ctx, onAction, onClose }: SpotSearchProps) {
  const [query, setQuery] = useState("");
  const [asyncRows, setAsyncRows] = useState<SpotRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [corpus, setCorpus] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => ctx.components.map((c) => c.path), [ctx.components]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // On open: fetch the quick-open corpus once, and bring the persistent index
  // up to date (incremental — a warm index is a handful of stats). Looping
  // while `more` is bounded so a cold index can't hold the palette hostage.
  useEffect(() => {
    void ipc.fsListFiles(roots).then(setCorpus).catch(() => setCorpus([]));
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < 8 && !cancelled; i++) {
        const report = await ipc.spotIngest().catch(() => null);
        if (!report?.more) break;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roots.join("\n")]);

  // The synchronous sources — recomputed every keystroke, no round trips.
  const syncRows = useMemo(
    () => [
      ...actionRows(query, ctx),
      ...tabRows(query, ctx),
      ...serverRows(query, ctx),
      ...sessionRows(query, ctx),
      ...taskRows(query, ctx),
      ...prRows(query),
    ],
    [query, ctx],
  );

  // The debounced ones. Stale responses are dropped rather than merged late —
  // results for a query you're no longer typing are noise under the cursor.
  useEffect(() => {
    if (!query.trim()) {
      setAsyncRows([]);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      void Promise.all([
        fileRows(query, corpus),
        contentRows(query, roots),
        codeSymbolRows(query, roots),
        indexRows(query, ctx),
        ticketRows(query, roots),
      ])
        .then((groups) => {
          if (cancelled) return;
          // A transcript hit and a live session row can name the same session;
          // the session row (sync, openable identically) wins.
          const seen = new Set(syncRows.map((r) => r.id));
          setAsyncRows(groups.flat().filter((r) => !seen.has(r.id)));
        })
        .finally(() => !cancelled && setBusy(false));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, corpus, roots.join("\n"), ctx]);

  const items = useMemo(
    () => sectioned([...syncRows, ...asyncRows]),
    [syncRows, asyncRows],
  );
  const selectable = useMemo(
    () => items.filter((i): i is SpotRow => !("header" in i)),
    [items],
  );

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    setSel((i) => Math.min(i, Math.max(0, selectable.length - 1)));
  }, [selectable.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".palette-row-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const commit = (row: SpotRow | undefined) => {
    if (!row) return;
    onClose();
    onAction(row.action);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette spot-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Search everything, or type a task…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, selectable.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(selectable[sel]);
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {selectable.length === 0 && (
            <div className="palette-empty">
              {busy ? "Searching…" : query.trim() ? "No results" : "Type to search"}
            </div>
          )}
          {items.map((item) =>
            "header" in item ? (
              <div key={`h:${item.header}`} className="spot-group">
                {item.header}
              </div>
            ) : (
              <div
                key={item.id}
                className={`palette-row ${
                  selectable.indexOf(item) === sel ? "palette-row-active" : ""
                }`}
                onMouseEnter={() => setSel(selectable.indexOf(item))}
                onClick={() => commit(item)}
              >
                {item.icon && <span className="spot-icon">{item.icon}</span>}
                <span className="palette-name">{item.title}</span>
                {item.detail && (
                  <span className="palette-snippet">{item.detail}</span>
                )}
              </div>
            ),
          )}
        </div>
        <div className="palette-foot">
          <span>SpotSearch{busy ? " · searching…" : ""}</span>
          <span>↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  );
}

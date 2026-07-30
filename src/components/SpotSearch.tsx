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
//
// What it searches is not decided here: this renders whatever the source
// registry (spotSources.ts) holds, in the order it holds it, so adding a kind
// of result never touches this file.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as ipc from "../ipc";
import { fuzzyRanges } from "../fuzzy";
import { SearchIcon } from "./icons";
import { SpotRowIcon } from "./spotIcons";
import { runIngest } from "../spotIndex";
import { thumbnail } from "../pageCapture";
import {
  attachmentLabel,
  briefWithAttachments,
  composerRows,
  isPrompt,
  pastedImages,
  type SpotAttachment,
} from "../spotCompose";
import {
  deferredRows,
  instantRows,
  spotGroupOrder,
  type SpotAction,
  type SpotContext,
  type SpotRow,
} from "../spotSources";

interface SpotSearchProps {
  ctx: SpotContext;
  onAction: (action: SpotAction) => void;
  onClose: () => void;
}

type Entry =
  | { header: string; count: number }
  | { row: SpotRow; index: number };

/** Flatten grouped rows into the render list: a header before each group, in
 *  the fixed section order, and each row carrying its own index in the
 *  selectable list (the palette re-renders this on every keystroke — looking an
 *  index up per row while rendering is quadratic). */
function sectioned(rows: SpotRow[]): Entry[] {
  const byGroup = new Map<string, SpotRow[]>();
  for (const r of rows) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }
  const out: Entry[] = [];
  let index = 0;
  // Registered order first, then any section a source filled without declaring
  // it — an unplaced group is shown last, never dropped.
  const order = spotGroupOrder();
  const groups = [...order, ...[...byGroup.keys()].filter((g) => !order.includes(g))];
  for (const g of groups) {
    const list = byGroup.get(g);
    if (!list?.length) continue;
    out.push({ header: g, count: list.length });
    for (const row of list.sort((a, b) => a.score - b.score)) {
      out.push({ row, index: index++ });
    }
  }
  return out;
}

/** Groups whose detail is a short status token rather than prose — rendered as
 *  a chip on the right so the eye can skim states down a column. */
const CHIP_GROUPS = new Set(["Open Tabs", "Servers", "Tickets"]);

/** The title with the matched characters marked. Falls back to plain text when
 *  the query doesn't subsequence-match this particular string (a row can match
 *  on its haystack — a prompt, a path — and not on what it displays). */
function Marked({ text, query }: { text: string; query: string }) {
  const ranges = useMemo(() => {
    const q = query.trim();
    return q ? fuzzyRanges(q, text) : null;
  }, [text, query]);
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark className="spot-mark" key={i}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export function SpotSearch({ ctx, onAction, onClose }: SpotSearchProps) {
  const [query, setQuery] = useState("");
  const [asyncRows, setAsyncRows] = useState<SpotRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [corpus, setCorpus] = useState<string[]>([]);
  /** Images pasted into the field, already written under `.canopy/spot/` so an
   *  agent can open them by path. Held here rather than encoded into the query:
   *  the text is what gets searched, and a base64 blob is not a search term. */
  const [shots, setShots] = useState<SpotAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Hover only takes the selection after the pointer has actually moved:
  // scrolling the keyboard selection into view slides rows under a resting
  // cursor, and a mouseenter from that would yank the selection back.
  const hoverArmed = useRef(false);
  const roots = useMemo(() => ctx.components.map((c) => c.path), [ctx.components]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // On open: fetch the quick-open corpus once, and bring the persistent index
  // up to date (incremental — a warm index is a handful of stats). Looping
  // while `more` is bounded so a cold index can't hold the palette hostage.
  // The index does not depend on this: spotIndexJob.ts keeps it current while
  // the app runs. This is the last-second top-up, and it joins that job's run
  // if one is already going.
  useEffect(() => {
    void ipc.fsListFiles(roots).then(setCorpus).catch(() => setCorpus([]));
    // What the index holds is opt-out (Settings → SpotSearch); the call is made
    // either way, because it is also what purges an agent just switched off —
    // skipping it entirely would leave the old content searchable.
    void runIngest(roots);
  }, [roots.join("\n")]);

  // ProjectView hands down a fresh ctx object on every render (pty stats tick
  // every 2s). The instant sources want the newest one; the debounced ones must
  // not restart their timer for it, so they read it through a ref.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // The synchronous sources — recomputed every keystroke, no round trips.
  const syncRows = useMemo(
    () => instantRows({ query, ctx, corpus, roots, attachments: shots.length }),
    [query, ctx, corpus, roots, shots.length],
  );
  const syncRowsRef = useRef(syncRows);
  syncRowsRef.current = syncRows;

  /** Typing has become writing: a sentence, a line break, or a pasted image.
   *  Ranking a paragraph against filenames produces a list of things that share
   *  letters with it and answer nothing, so the palette stops offering matches
   *  and offers the two things you can do with what you wrote. */
  const composing = isPrompt(query, shots.length);

  // The debounced ones. Stale responses are dropped rather than merged late —
  // results for a query you're no longer typing are noise under the cursor.
  useEffect(() => {
    // Composing is not searching. Once the text is a prompt the only rows the
    // palette will show are the actions, so the slow sources are being asked to
    // rank a paragraph against filenames and transcripts for a list that is then
    // filtered away — and they were paying for it in the one place it shows: a
    // progress hairline sweeping under the box and "searching…" in the footer,
    // for a search whose every result was already discarded.
    if (composing || !query.trim()) {
      setAsyncRows([]);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      void deferredRows({ query, ctx: ctxRef.current, corpus, roots })
        .then((rows) => {
          if (cancelled) return;
          // A transcript hit and a live session row can name the same session;
          // the session row (sync, openable identically) wins.
          const seen = new Set(syncRowsRef.current.map((r) => r.id));
          setAsyncRows(rows.filter((r) => !seen.has(r.id)));
        })
        .finally(() => !cancelled && setBusy(false));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, corpus, roots.join("\n"), composing]);

  const items = useMemo(() => {
    const all = [...syncRows, ...asyncRows];
    return sectioned(composing ? all.filter((r) => r.group === "Actions") : all);
  }, [syncRows, asyncRows, composing]);
  const selectable = useMemo(
    () => items.flatMap((i) => ("row" in i ? [i.row] : [])),
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
    // The pasted images belong to whatever this row sends off. Only the two
    // rows that carry prose can carry them — everything else opens a thing that
    // already exists and has nothing to do with a screenshot.
    if (shots.length > 0 && row.action.type === "run-task") {
      onAction({ type: "run-task", brief: briefWithAttachments(row.action.brief, shots) });
      return;
    }
    if (shots.length > 0 && row.action.type === "start-research") {
      onAction({
        type: "start-research",
        question: briefWithAttachments(row.action.question, shots),
      });
      return;
    }
    // A note keeps its images as attachments rather than as paths inlined into
    // the text: the note outlives this palette, this project's worktrees, and
    // the `.canopy/spot/` directory these are staged in, so what it needs is
    // the files themselves — which is what the paths let ProjectView copy.
    if (shots.length > 0 && row.action.type === "save-note") {
      onAction({
        type: "save-note",
        text: row.action.text,
        attachments: shots.map((s) => s.path),
      });
      return;
    }
    onAction(row.action);
  };

  /** Paste an image: write it where an agent can read it, keep a thumbnail.
   *  Same path the preview's Screenshot button uses, so the two produce
   *  interchangeable briefs. */
  const attach = async (files: File[]) => {
    const dir = ctx.components[0]?.path;
    if (!dir || files.length === 0) return;
    setAttaching(true);
    for (const file of files) {
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.readAsDataURL(file);
        });
        if (!base64) continue;
        const path = await ipc.spotSaveContextImage(dir, base64);
        // The chip appears on the write, not on the picture. Decoding happens
        // in an <img> whose onload and onerror both stay silent for something
        // that isn't really an image — waiting on it would mean a paste that
        // vanished, with the field stuck saying it was working on it.
        setShots((prev) => [...prev, { path, thumb: "" }]);
        void thumbnail(base64, 96)
          .then((thumb) =>
            setShots((prev) => prev.map((s) => (s.path === path ? { ...s, thumb } : s))),
          )
          .catch(() => {});
      } catch (err) {
        void ipc.jsLog("warn", `spot: could not attach a pasted image: ${String(err)}`);
      }
    }
    setAttaching(false);
    inputRef.current?.focus();
  };

  /** Move the cursor by `d`, wrapping at both ends — a list this long is
   *  faster to reach the bottom of by pressing Up once. */
  const move = (d: number) => {
    hoverArmed.current = false;
    setSel((i) => {
      const n = selectable.length;
      if (n === 0) return 0;
      return (((i + d) % n) + n) % n;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      move(8);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      move(-8);
    } else if (e.key === "Home" && !query) {
      e.preventDefault();
      setSel(0);
    } else if (e.key === "End" && !query) {
      e.preventDefault();
      setSel(Math.max(0, selectable.length - 1));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit(selectable[sel]);
    } else if (e.key === "Backspace" && !query && shots.length > 0) {
      // Nothing left to delete in the text, so delete the thing before it.
      e.preventDefault();
      setShots((prev) => prev.slice(0, -1));
    }
  };

  const active = selectable[sel];

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette spot-palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={`spot-field${composing ? " spot-field-composing" : ""}`}>
          <SearchIcon size={15} className="spot-field-icon" />
          <div className="spot-field-body">
            {shots.length > 0 && (
              <div className="spot-shots">
                {shots.map((shot) => (
                  <span className="spot-shot" key={shot.path} title={shot.path}>
                    {shot.thumb ? (
                      <img className="spot-shot-thumb" src={shot.thumb} alt="" />
                    ) : (
                      <span className="spot-shot-thumb spot-shot-blank" />
                    )}
                    <span className="spot-shot-name">{attachmentLabel(shot.path)}</span>
                    <button
                      type="button"
                      className="spot-shot-drop"
                      aria-label={`Remove ${attachmentLabel(shot.path)}`}
                      onClick={() => {
                        setShots((prev) => prev.filter((s) => s.path !== shot.path));
                        inputRef.current?.focus();
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              className="palette-input spot-input"
              value={query}
              rows={composerRows(query)}
              placeholder={
                shots.length > 0
                  ? "What should an agent do with this?"
                  : "Search everything, or type a task…"
              }
              role="combobox"
              aria-expanded
              aria-controls="spot-list"
              aria-activedescendant={active ? `spot-row-${active.id}` : undefined}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const images = pastedImages(e.clipboardData);
                if (images.length === 0) return;
                // Only swallow the paste when there is an image in it — a paste
                // that is also text should still put the text in the field.
                e.preventDefault();
                void attach(images);
              }}
            />
          </div>
          {(query || shots.length > 0) && (
            <button
              type="button"
              className="spot-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                setShots([]);
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
        </div>
        {/* A hairline that sweeps while the slow sources are out — the footer
            saying "searching…" is easy to miss under a full list. */}
        <div className={`spot-progress${busy || attaching ? " spot-progress-on" : ""}`} />
        <div
          className="palette-list"
          ref={listRef}
          id="spot-list"
          role="listbox"
          onMouseMove={() => {
            hoverArmed.current = true;
          }}
        >
          {selectable.length === 0 && (
            <div className="palette-empty spot-empty">
              {busy ? (
                "Searching…"
              ) : query.trim() ? (
                <>
                  <span>Nothing matched “{query.trim()}”.</span>
                  <span className="spot-empty-hint">
                    Press <kbd className="spot-key">↵</kbd> to run it as a task
                    instead.
                  </span>
                </>
              ) : (
                "Type to search"
              )}
            </div>
          )}
          {items.map((item) =>
            "header" in item ? (
              <div key={`h:${item.header}`} className="spot-group">
                <span>{item.header}</span>
                <span className="spot-group-count">{item.count}</span>
              </div>
            ) : (
              <div
                key={item.row.id}
                id={`spot-row-${item.row.id}`}
                role="option"
                aria-selected={item.index === sel}
                // The title is split into <mark>s and the row can be
                // ellipsised, so both the label a screen reader reads and the
                // tooltip a truncated row shows come from the whole string.
                aria-label={[item.row.title, item.row.detail]
                  .filter(Boolean)
                  .join(" — ")}
                title={[item.row.title, item.row.detail].filter(Boolean).join(" — ")}
                className={`palette-row spot-row ${
                  item.index === sel ? "palette-row-active" : ""
                }`}
                onMouseEnter={() => hoverArmed.current && setSel(item.index)}
                onClick={() => commit(item.row)}
              >
                <span className="spot-icon">
                  <SpotRowIcon row={item.row} />
                </span>
                <span className="palette-name spot-title">
                  <Marked text={item.row.title} query={query} />
                </span>
                {item.row.detail && (
                  <span
                    className={
                      CHIP_GROUPS.has(item.row.group)
                        ? "spot-chip"
                        : "palette-snippet spot-detail"
                    }
                  >
                    {item.row.detail}
                  </span>
                )}
                <span className="spot-enter" aria-hidden>
                  ↵
                </span>
              </div>
            ),
          )}
        </div>
        <div className="palette-foot">
          <span className="spot-foot-left">
            <span>SpotSearch</span>
            {selectable.length > 0 && (
              <span className="spot-count">
                {selectable.length} result{selectable.length === 1 ? "" : "s"}
              </span>
            )}
            {busy && <span className="spot-count">searching…</span>}
          </span>
          <span className="spot-hints">
            <kbd className="spot-key">↑↓</kbd> navigate
            <kbd className="spot-key">↵</kbd> open
            <kbd className="spot-key">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

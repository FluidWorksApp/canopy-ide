import { useEffect, useMemo, useRef, useState } from "react";
import { useEscapeLayer } from "../useEscape";
import {
  completion,
  componentAt,
  lastFolder,
  orderComponents,
  rankComponents,
  type PickerComponent,
} from "../componentPicker";

/**
 * "Open it in which component?" A large, bold field over the project's
 * components, the one used last at the top. Type to filter, and the rest of the
 * best match appears greyed out; Enter opens it, Tab fills it in, Esc cancels.
 * Shown only when a project has more than one component.
 */
export function ComponentPicker({
  title,
  components,
  recents,
  activePath,
  onPick,
  onCancel,
}: {
  /** What is being opened: "New shell", "New Claude Code"… */
  title: string;
  components: PickerComponent[];
  /** Component ids, most recently used first. */
  recents: string[];
  /** The tab in front, if any, so "current tab" can be flagged. */
  activePath?: string | null;
  onPick: (component: PickerComponent) => void;
  onCancel: () => void;
}) {
  useEscapeLayer(true, { onEscape: () => cancel() });
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Where the keyboard was, so cancelling puts it back instead of dropping it.
  const before = useRef<Element | null>(document.activeElement);

  const ordered = useMemo(() => orderComponents(components, recents, activePath), [components, recents, activePath]);
  const rows = useMemo(() => rankComponents(query, ordered), [query, ordered]);
  const ghost = completion(query, rows[0]);
  const lastUsed = recents.length ? ordered[0]?.id : undefined;
  const current = componentAt(components, activePath)?.id;

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-row-active")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function cancel() {
    onCancel();
    const el = before.current;
    if (el instanceof HTMLElement && el.isConnected) requestAnimationFrame(() => el.focus());
  }

  return (
    <div className="palette-backdrop" onMouseDown={cancel}>
      <div className="palette cpick" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cpick-title">
          {title} <span className="cpick-title-dim">in which component?</span>
        </div>
        <div className="cpick-field">
          {/* The typed text is invisible here and only holds the grey completion in place behind the real input. */}
          <div className="cpick-ghost" aria-hidden="true">
            <span className="cpick-ghost-typed">{query}</span>
            {ghost?.rest}
          </div>
          <input
            ref={inputRef}
            className="cpick-input"
            value={query}
            placeholder={ordered[0]?.label ?? "Component"}
            aria-label="Component"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => Math.max(i - 1, 0));
              } else if (e.key === "Tab") {
                e.preventDefault();
                if (ghost) setQuery(ghost.full);
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (rows[sel]) onPick(rows[sel]);
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="Components">
          {rows.length === 0 && <div className="palette-empty">No component matches “{query.trim()}”</div>}
          {rows.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === sel}
              className={`palette-row cpick-row ${i === sel ? "palette-row-active" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => onPick(c)}
            >
              <span className="cpick-name">{c.label}</span>
              <span className="cpick-path">{lastFolder(c.path)}</span>
              {c.id === lastUsed && <span className="cpick-tag">last used</span>}
              {c.id === current && <span className="cpick-tag cpick-tag-current">this tab</span>}
            </div>
          ))}
        </div>
        <div className="cpick-hint">
          <span>↵ open</span>
          <span>Tab complete</span>
          <span>↑↓ choose</span>
          <span>Esc cancel</span>
        </div>
      </div>
    </div>
  );
}

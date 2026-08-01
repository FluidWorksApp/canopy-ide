// A small, generic context menu. The webview's own menu (Reload / Inspect
// Element, or macOS's Look Up / Translate over selected text) is meaningless in
// a desktop IDE, so the app suppresses it globally (see main.tsx) and shows
// this instead.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useEscapeLayer } from "./useEscape";
import { fuzzy } from "./fuzzy";

export interface MenuItem {
  /** Omitted only on a plain separator (`separator: true` with no label). */
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  /** Renders a divider; label is ignored. */
  separator?: boolean;
  disabled?: boolean;
  /** Leading glyph — the launcher menu uses the agent brand marks. */
  icon?: ReactNode;
  /** Trailing note, dimmed and right-aligned (e.g. "install"). */
  hint?: string;
  /** Nested items, shown in a panel attached to this row. Used where a
   *  choice has its own list ("New agent ▸" → every installed CLI) and
   *  flattening it would bury the common case under the rare one. */
  submenu?: MenuItem[];
}

/** Turns a menu into a list you can search, for the case a menu is otherwise
 *  bad at: more rows than anyone wants to read. Without it the only honest
 *  thing a long menu can do is truncate and point somewhere else — which is a
 *  dead end wearing a row's clothes. */
export interface MenuFilter {
  /** Placeholder for the search box. */
  placeholder?: string;
  /** How many rows to offer before anything is typed. The rest are not gone —
   *  the box searches all of them — so this can stay small enough to read. */
  preview?: number;
  /** What the rows are, for the line that counts the ones held back:
   *  "132 more branches — type to search". */
  noun?: string;
  /** Said in the empty list when a query matches nothing. */
  empty?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  /** Treat `y` as the menu's bottom edge and grow upward from it. */
  above?: boolean;
  /** Put a search box at the top and let it narrow the rows below. */
  filter?: MenuFilter;
  onClose: () => void;
}

/** Rows the search box will offer, and how many it is holding back.
 *
 *  Empty query: the first `preview` rows, which for a list handed back newest
 *  first is "the ones you touched recently" — the shortcut the menu was always
 *  meant to be. Typed query: every row that matches, best match first, because
 *  once you've said what you're looking for recency isn't the question. */
function visibleRows(
  items: MenuItem[],
  filter: MenuFilter,
  query: string,
): { rows: MenuItem[]; hidden: number } {
  if (!query) {
    const limit = filter.preview;
    if (limit == null) return { rows: items, hidden: 0 };
    const rows: MenuItem[] = [];
    let shown = 0;
    let hidden = 0;
    for (const it of items) {
      // Headings and dividers are the menu's own scaffolding, not rows you
      // scroll past, so they never spend the budget or count as held back.
      if (it.separator) rows.push(it);
      else if (shown < limit) {
        rows.push(it);
        shown++;
      } else hidden++;
    }
    return { rows, hidden };
  }
  const rows = items
    .map((it, i) => ({ it, i, s: it.separator || !it.label ? null : fuzzy(query, it.label) }))
    .filter((r): r is { it: MenuItem; i: number; s: number } => r.s !== null)
    // Score first, original order to break ties — a stable, explicable list
    // rather than whatever the sort happened to do with equal ranks.
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((r) => r.it);
  if (rows.length === 0)
    return { rows: [{ label: filter.empty ?? "Nothing matches", disabled: true }], hidden: 0 };
  return { rows, hidden: 0 };
}

/** Rows a keypress can land on: not a heading, not disabled, and something
 *  Enter can actually do. A row that only opens a panel is left to the pointer
 *  rather than highlighted as if Enter would follow it somewhere. */
const pickable = (rows: MenuItem[]) =>
  rows.flatMap((it, i) => (!it.separator && !it.disabled && it.onClick ? [i] : []));

export function ContextMenu({ x, y, items, above, filter, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [query, setQuery] = useState("");
  // Which row Enter would take. A search box you have to reach back to the
  // mouse to act on is half a search box.
  const [active, setActive] = useState(-1);
  useEscapeLayer();

  const q = query.trim();
  const { rows, hidden } = useMemo(
    () => (filter ? visibleRows(items, filter, q) : { rows: items, hidden: 0 }),
    [items, filter, q],
  );

  // Type to search: the list under the box is a different list now, so the
  // selection starts again at the top of it.
  useEffect(() => setActive(pickable(rows)[0] ?? -1), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!filter) return;
    inputRef.current?.focus();
  }, [filter]);

  useLayoutEffect(() => {
    const el = rowsRef.current?.querySelector(".ctx-item-active");
    // Guarded: jsdom has no scrollIntoView, and neither has a row that is
    // already in view for any reason worth throwing over.
    if (el instanceof HTMLElement) el.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  // Keep the menu inside the window — near the bottom/right edge it would
  // otherwise open off-screen and be unusable.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Math.max guards the case where the menu is larger than the window, which
    // would otherwise clamp it to a negative offset and cut off the top/left.
    // Growing upward needs the height, which only exists after layout — hence
    // measuring here rather than guessing at the call site.
    const top = above ? y - r.height : y;
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(top, window.innerHeight - r.height - 6)),
    });
    // `rows.length` because a searched menu changes height as you type: an
    // upward one measured only on open would keep its old top and walk its
    // bottom edge down over the control it belongs to.
  }, [x, y, above, rows.length]);

  useEffect(() => {
    // Capture phase, so a click on the page closes the menu before any
    // underlying handler reacts to it. That means this fires before the event
    // reaches our own buttons too, so ignore anything inside the menu by
    // hit-testing the target — a bubble-phase stopPropagation on the container
    // would run too late to prevent this listener, closing the menu (and
    // unmounting the button) before its click could ever fire.
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    // Only this menu goes away on Escape — the panel it was opened from stays,
    // because the menu counts itself as an Escape layer below.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const bail = () => onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", bail);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", bail);
    };
  }, [onClose]);

  /** Arrows walk the rows, Enter takes the one under the highlight. Escape is
   *  left alone: the window listener above already closes the whole menu, and
   *  clearing the query first would make the first Escape look like nothing. */
  const onKey = (e: React.KeyboardEvent) => {
    const idx = pickable(rows);
    if (!idx.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const cur = idx.indexOf(active);
      // Nothing highlighted yet — down starts at the top, up at the bottom.
      if (cur === -1) setActive(dir === 1 ? idx[0] : idx[idx.length - 1]);
      else setActive(idx[(cur + dir + idx.length) % idx.length]);
      return;
    }
    if (e.key === "Enter") {
      const it = rows[active];
      if (!it?.onClick) return;
      e.preventDefault();
      it.onClick();
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className={`ctx-menu ${filter ? "ctx-menu-search" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {filter && (
        <input
          ref={inputRef}
          className="ctx-search"
          placeholder={filter.placeholder ?? "Search…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
      )}
      {filter ? (
        <div className="ctx-rows" ref={rowsRef}>
          <MenuRows items={rows} onClose={onClose} active={active} />
        </div>
      ) : (
        <MenuRows items={items} onClose={onClose} />
      )}
      {/* The rest of the list, named rather than dangled: it says where they
          are (right here, behind the box) instead of sending you elsewhere. */}
      {hidden > 0 && (
        <div className="ctx-more">
          {hidden} more{filter?.noun ? ` ${filter.noun}` : ""} — type to search
        </div>
      )}
    </div>
  );
}

/** One level of a menu: the rows, and whichever of their panels is open.
 *
 *  Recursive, because `submenu` is a property of a MenuItem at any depth and
 *  the type has always said so. It used to be rendered only one level down —
 *  a submenu's rows were drawn as plain buttons that ignored their own
 *  `submenu` and closed the menu on click. Composing two menus that each
 *  worked alone therefore produced a row that looked live, highlighted on
 *  hover, and did nothing at all: "Send screenshot ▸ Agent ▸ New agent in
 *  canopy-website" was dead the moment it moved one level deeper.
 *
 *  Each level owns its own open-panel state, so opening a child never closes
 *  the parent that contains it. */
function MenuRows({
  items,
  onClose,
  active,
}: {
  items: MenuItem[];
  onClose: () => void;
  /** Index of the row the search box's Enter would take, if there is one. Only
   *  the level holding the box has one: a submenu is reached with the pointer,
   *  and a highlight inside it would claim a keyboard path that isn't there. */
  active?: number;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  // The attached panel is positioned relative to its row, so it inherits none
  // of the parent's viewport clamping — near the bottom or right edge it ran
  // straight off screen. Measure the real rect once it opens and pull it back.
  const [subFix, setSubFix] = useState<{ top: number; flip: boolean }>({
    top: 0,
    flip: false,
  });
  useLayoutEffect(() => {
    if (openSub == null) {
      setSubFix({ top: 0, flip: false });
      return;
    }
    const el = subRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    // Lift it just enough to fit; never push it above the top edge.
    const overflowY = r.bottom - (window.innerHeight - margin);
    const top = overflowY > 0 ? -Math.min(overflowY, Math.max(0, r.top - margin)) : 0;
    const flip = r.right > window.innerWidth - margin;
    setSubFix({ top, flip });
  }, [openSub]);

  return (
    <>
      {items.map((item, i) =>
        item.separator ? (
          // A separator with a label is a section heading, which is how the
          // agent menus tell "running" from "new" without a second widget.
          item.label ? (
            <div key={i} className="ctx-heading">
              {item.label}
            </div>
          ) : (
            <div key={i} className="ctx-sep" />
          )
        ) : item.submenu ? (
          <div
            key={i}
            className="ctx-sub-anchor"
            // Hover switches between submenus, but never opens the first one:
            // with hover-to-open, clicking a row to close its panel reopened it
            // the instant the pointer crossed back in, so it read as a panel
            // that refused to shut. Opening is a click; once one is open,
            // sliding down the list still swaps panels the way you'd expect.
            onMouseEnter={() => setOpenSub((cur) => (cur === null ? null : i))}
          >
            <button
              className={`ctx-item ${openSub === i ? "ctx-item-on" : ""}`}
              onClick={() => setOpenSub((cur) => (cur === i ? null : i))}
            >
              {item.icon != null && <span className="ctx-icon">{item.icon}</span>}
              <span className="ctx-label">{item.label}</span>
              <span className="ctx-caret">›</span>
            </button>
            {openSub === i && (
              <div
                ref={subRef}
                className={`ctx-menu ctx-submenu ${subFix.flip ? "ctx-submenu-left" : ""}`}
                style={{ marginTop: subFix.top }}
              >
                <MenuRows items={item.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        ) : (
          <button
            key={i}
            className={`ctx-item ${item.danger ? "ctx-danger" : ""} ${
              active === i ? "ctx-item-active" : ""
            }`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon != null && <span className="ctx-icon">{item.icon}</span>}
            <span className="ctx-label">{item.label}</span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </>
  );
}

/** Menu state helper: `open(e, items)` from an onContextMenu handler. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    /** y is the bottom edge to grow up from, not the top to hang down from. */
    above?: boolean;
    filter?: MenuFilter;
  } | null>(null);
  /** Which control opened it, and when it last closed.
   *
   *  A second click on the same button has to close the menu, and it couldn't:
   *  the document listener runs in the capture phase, so it closed the menu
   *  *before* the button's own onClick fired, and that onClick then reopened it.
   *  The menu looked permanently stuck open and nothing but Escape or a click
   *  elsewhere dismissed it. So a close records its anchor, and an open from
   *  that same anchor moments later is the second half of one click: ignore it
   *  and stay closed. A different button still opens normally — this is a
   *  toggle, not a lockout. */
  const anchor = useRef<Element | null>(null);
  const closedAt = useRef<{ at: number; anchor: Element | null }>({
    at: 0,
    anchor: null,
  });
  const isSecondClick = (e: React.MouseEvent) =>
    closedAt.current.anchor === e.currentTarget &&
    performance.now() - closedAt.current.at < 300;

  /** Every opener takes the same trailing options, so a menu long enough to
   *  need a search box gets one wherever it is opened from. */
  const open = (e: React.MouseEvent, items: MenuItem[], filter?: MenuFilter) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items, filter });
  };
  /** For a button that opens a dropdown rather than a right-click. Anchoring to
   *  the pointer is right for a context menu and wrong for a button: the panel
   *  lands wherever inside the control you happened to click, covering the thing
   *  you just pressed. Hang it off the button's bottom-left instead, so it reads
   *  as belonging to that button. */
  const openUnder = (e: React.MouseEvent, items: MenuItem[], filter?: MenuFilter) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSecondClick(e)) return;
    anchor.current = e.currentTarget;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items, filter });
  };
  /** For a control near the bottom of the window, where a menu hung below it
   *  would open off-screen and only be dragged back by the viewport clamp —
   *  landing wherever it fits rather than where it belongs. This anchors it to
   *  the button's top edge instead, growing upward. The caller measures after
   *  layout, so the y is the button's top and ContextMenu's own clamp does the
   *  rest once it knows the menu's height. */
  const openAbove = (e: React.MouseEvent, items: MenuItem[], filter?: MenuFilter) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSecondClick(e)) return;
    anchor.current = e.currentTarget;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.top - 6, items, above: true, filter });
  };
  const close = () => {
    closedAt.current = { at: performance.now(), anchor: anchor.current };
    anchor.current = null;
    setMenu(null);
  };
  return { menu, open, openUnder, openAbove, close };
}

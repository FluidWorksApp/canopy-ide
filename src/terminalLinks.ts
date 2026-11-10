// Terminal links follow the same fixed rule as every other URL in Canopy: a
// plain click opens internally and a command-click opens the OS browser.
import { IS_MAC } from "./platform";
import { commandHeld, format } from "./shortcuts";

/** The chord, spelled the way this platform spells it. */
export const LINK_CHORD = `${format("open-external")}${IS_MAC ? " " : "+"}click`;

/** True when this mouse event is a request to follow the link under it.
 *
 *  Left button only. xterm's Linkifier activates on *any*
 *  mouseup over a link, so without this a right-click — the gesture that opens
 *  the terminal's own context menu — opened the URL as well.
 *
 *  The other platform modifier must be off: on macOS Ctrl+click is a
 *  right-click, and ⌃⌘-click belongs to whatever the OS makes of it.
 *
 *  `hasSelection` is the terminal's own selection state at mouseup. The gesture
 *  that follows a link and the gesture that selects text are the same button,
 *  and the drag ends over the link it started on — so a bare release that
 *  leaves text selected is a selection, not a navigation. A command-click is
 *  unambiguous and still opens externally when old text remains selected. */
export function opensLink(e: MouseEvent, hasSelection = false): boolean {
  if (e.button !== 0) return false;
  // The *other* platform's modifier is never a follow: on
  // macOS Ctrl+click is a right-click, and ⌃⌘-click belongs to the OS.
  if (IS_MAC ? e.ctrlKey : e.metaKey) return false;
  return !hasSelection || commandHeld(e);
}

export interface TerminalFileLink {
  path: string;
  /** Zero-based start and exclusive end columns. */
  start: number;
  end: number;
  line?: number;
}

const withLine = (value: string) => {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(value);
  return match
    ? { path: match[1], line: Number(match[2]) }
    : { path: value, line: undefined };
};

/** Find quoted and unquoted absolute paths in one terminal row. */
export function terminalFileLinks(text: string): TerminalFileLink[] {
  const found: TerminalFileLink[] = [];
  const occupied: [number, number][] = [];
  const add = (value: string, start: number, end: number) => {
    const trimmed = value.replace(/[.,;!?)\]}]+$/, "");
    if (!trimmed || occupied.some(([a, b]) => start < b && end > a)) return;
    const at = withLine(trimmed);
    found.push({ ...at, start, end: start + trimmed.length });
    occupied.push([start, end]);
  };

  for (const match of text.matchAll(/(['"])((?:\/|[A-Za-z]:[\\/])[^'"\r\n]+)\1/g)) {
    const start = (match.index ?? 0) + 1;
    add(match[2], start, start + match[2].length);
  }
  for (const match of text.matchAll(
    /(?:^|[\s([{<])((?:\/(?!\/)|[A-Za-z]:[\\/])[^\s'"<>|]*)/g,
  )) {
    const value = match[1];
    const start = (match.index ?? 0) + match[0].length - value.length;
    add(value, start, start + value.length);
  }
  return found.sort((a, b) => a.start - b.start);
}

const TRAILING_PUNCT = /[.,;!?)\]}]+$/;
/** A word that could end a file name: it carries an extension. */
const ENDS_LIKE_A_FILE = /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?[.,;!?)\]}]*$/;
const MAX_EXTRA_WORDS = 8;

/** Paths with spaces in them ("…/EveryApp store policy risk.md"). The row
 *  scanner above stops a bare path at the first space, because prose follows
 *  paths far more often than spaces sit inside them. So a link followed by more
 *  words is tried again with those words appended, and kept only where such a
 *  file really exists: the file system, not a guess, decides where it ends.
 *
 *  Only words that could finish a file name (they carry an extension) are
 *  tried, which keeps a long sentence after a path down to a stat or two. The
 *  longest existing candidate wins. */
export async function extendSpacedLinks(
  text: string,
  links: TerminalFileLink[],
  exists: (path: string) => Promise<boolean>,
): Promise<TerminalFileLink[]> {
  const out: TerminalFileLink[] = [];
  for (const link of links) {
    // Only a bare path that ran into a single space, and not one that already
    // names a line (":12" ends a path).
    if (link.line !== undefined || text[link.end] !== " ") {
      out.push(link);
      continue;
    }
    const words = [...text.slice(link.end).matchAll(/ +[^\s'"<>|]+/g)];
    // Words must be contiguous from the link: stop at the first gap in the match.
    let consumed = 0;
    const usable: string[] = [];
    for (const word of words) {
      if ((word.index ?? 0) !== consumed || usable.length >= MAX_EXTRA_WORDS) break;
      usable.push(word[0]);
      consumed += word[0].length;
    }
    let best: TerminalFileLink | null = null;
    let joined = "";
    for (const word of usable) {
      joined += word;
      if (!ENDS_LIKE_A_FILE.test(word)) continue;
      const trimmed = (link.path + joined).replace(TRAILING_PUNCT, "");
      const at = withLine(trimmed);
      if (await exists(at.path)) {
        best = { path: at.path, line: at.line, start: link.start, end: link.start + trimmed.length };
      }
    }
    out.push(best ?? link);
  }
  return out;
}

/** The bubble that appears while the pointer rests on a link. xterm underlines
 *  a hovered link whether or not the modifier is down, and an underline that
 *  does nothing when clicked reads as a broken link rather than a guarded one —
 *  so under "modifier" the affordance ships with its instruction. Under "click"
 *  the click does what the underline promises, and there is no chord to name. */
export interface LinkHint {
  /** Pointer entered a link; `e` places the bubble. */
  show(e: MouseEvent, kind?: "url" | "file"): void;
  hide(): void;
  dispose(): void;
}

/** Long enough that dragging the pointer across output doesn't strobe, short
 *  enough to arrive before the user has decided the link is dead. */
const SHOW_DELAY_MS = 300;
/** Gap between pointer and bubble, and the bubble's margin from the edges. */
const OFFSET = 10;
const MARGIN = 4;

/** Plain DOM rather than the React `<Tooltip>`: xterm hands hover and leave to
 *  us as imperative callbacks on a surface React does not render into. `host`
 *  must be a positioned element — the terminal's own container. */
export function createLinkHint(host: HTMLElement): LinkHint {
  let el: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    el?.remove();
    el = null;
  };

  const place = (node: HTMLDivElement, e: MouseEvent) => {
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const maxLeft = Math.max(MARGIN, host.clientWidth - w - MARGIN);
    node.style.left = `${Math.min(maxLeft, Math.max(MARGIN, x - w / 2))}px`;
    // Above the pointer, unless the link is near the top — then below it, so
    // the bubble never covers the thing it is describing.
    const above = y - h - OFFSET;
    node.style.top = `${above >= MARGIN ? above : y + OFFSET * 2}px`;
  };

  return {
    show(e, kind = "url") {
      clearTimeout(timer);
      // The event is pooled by nobody here, but it does not survive the delay
      // in any useful sense — read the coordinates now.
      const at = { clientX: e.clientX, clientY: e.clientY } as MouseEvent;
      timer = setTimeout(() => {
        timer = undefined;
        if (!el) {
          el = host.ownerDocument.createElement("div");
          el.className = "term-link-hint";
          const label = host.ownerDocument.createElement("span");
          label.className = "term-link-hint-label";
          const chip = host.ownerDocument.createElement("span");
          chip.className = "term-link-hint-chord";
          el.append(label);
          el.append(chip);
          host.append(el);
        }
        const label = el.querySelector<HTMLElement>(".term-link-hint-label");
        const chip = el.querySelector<HTMLElement>(".term-link-hint-chord");
        if (label)
          label.textContent = kind === "file" ? "Open file in Canopy" : "Open in Canopy";
        if (chip) {
          chip.textContent = kind === "file" ? "" : `${LINK_CHORD} for browser`;
          chip.hidden = kind === "file";
        }
        place(el, at);
      }, SHOW_DELAY_MS);
    },
    hide,
    dispose: hide,
  };
}

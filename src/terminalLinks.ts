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

/** The bubble that appears while the pointer rests on a link. xterm underlines
 *  a hovered link whether or not the modifier is down, and an underline that
 *  does nothing when clicked reads as a broken link rather than a guarded one —
 *  so under "modifier" the affordance ships with its instruction. Under "click"
 *  the click does what the underline promises, and there is no chord to name. */
export interface LinkHint {
  /** Pointer entered a link; `e` places the bubble. */
  show(e: MouseEvent): void;
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
    show(e) {
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
          label.textContent = "Open in Canopy";
          const chip = host.ownerDocument.createElement("span");
          chip.className = "term-link-hint-chord";
          chip.textContent = `${LINK_CHORD} for browser`;
          el.append(label);
          el.append(chip);
          host.append(el);
        }
        place(el, at);
      }, SHOW_DELAY_MS);
    },
    hide,
    dispose: hide,
  };
}

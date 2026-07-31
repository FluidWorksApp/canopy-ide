// Following a link in the terminal takes a bare click by default, and ⌘ (Ctrl
// off macOS) when Settings → Terminal → Link click says so.
//
// The chord is what every text surface that linkifies settles on (VS Code,
// JetBrains, iTerm2), and it exists because a bare click is also how you focus
// a pane and where a selection starts — terminal output is mostly URLs somebody
// else printed, so a bare click that navigates can land on a URL nobody chose.
// But an underlined link that ignores a click reads as a broken link, so the
// plain gesture is the default and the chord is the opt-in.
import { IS_MAC } from "./platform";
import { commandHeld, format } from "./shortcuts";
import type { LinkClickMode } from "./settings";

/** The chord, spelled the way this platform spells it. */
export const LINK_CHORD = `${format("link-follow")}${IS_MAC ? " " : "+"}click`;

/** True when this mouse event is a request to follow the link under it.
 *
 *  Left button only, in both modes. xterm's Linkifier activates on *any*
 *  mouseup over a link, so without this a right-click — the gesture that opens
 *  the terminal's own context menu — opened the URL as well.
 *
 *  The other platform modifier must be off: on macOS Ctrl+click is a
 *  right-click, and ⌃⌘-click belongs to whatever the OS makes of it.
 *
 *  `hasSelection` is the terminal's own selection state at mouseup. In "click"
 *  mode the gesture that follows a link and the gesture that selects text are
 *  the same button, and the drag ends over the link it started on — so a
 *  release that leaves text selected is a selection, not a navigation. The
 *  chord has no such collision, so it ignores this. */
export function opensLink(
  e: MouseEvent,
  mode: LinkClickMode = "modifier",
  hasSelection = false,
): boolean {
  if (e.button !== 0) return false;
  // The *other* platform's modifier is never a follow, in either mode: on
  // macOS Ctrl+click is a right-click, and ⌃⌘-click belongs to the OS.
  if (IS_MAC ? e.ctrlKey : e.metaKey) return false;
  if (mode === "click") return !hasSelection;
  // Shift and Alt may ride along — only the command modifier decides.
  return commandHeld(e);
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
 *  must be a positioned element — the terminal's own container. `mode` is read
 *  per hover, not captured, so changing the setting reaches open terminals. */
export function createLinkHint(
  host: HTMLElement,
  mode: () => LinkClickMode = () => "modifier",
): LinkHint {
  let el: HTMLDivElement | null = null;
  let chip: HTMLSpanElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    el?.remove();
    el = null;
    chip = null;
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
          label.textContent = "Open link";
          chip = host.ownerDocument.createElement("span");
          chip.className = "term-link-hint-chord";
          chip.textContent = LINK_CHORD;
          el.append(label);
          host.append(el);
        }
        // The bubble outlives a settings change; re-decide each hover. Detached
        // rather than hidden — the chip is a flex child, so `[hidden]` loses to
        // its own display rule.
        if (chip) {
          if (mode() === "modifier") el.append(chip);
          else chip.remove();
        }
        place(el, at);
      }, SHOW_DELAY_MS);
    },
    hide,
    dispose: hide,
  };
}

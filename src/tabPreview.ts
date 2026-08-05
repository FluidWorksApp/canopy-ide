// A live thumbnail of a tab that isn't in front.
//
// Every pane in a project stays mounted for as long as its tab is open — a
// background tab is hidden with `display: none`, never unmounted — so a
// switcher never has to reconstruct what a tab looks like. The DOM is already
// there; it just has no layout while it is hidden. Cloning that subtree into a
// box the size of the real pane gives it layout again, and scaling the box down
// gives the picture. It is the live tree, re-read every tick, so a diff that
// loads or a panel that repaints shows up in the thumbnail.
//
// Terminals are the exception, and the cheaper case: xterm paints through its
// own renderer, which a DOM clone does not carry, so their thumbnails are the
// buffer tail read as text — the same read Term.captureText and ptyText do.
// That one is live by construction: the buffer IS what the pty just wrote.

/** How many elements one clone may copy. Not a correctness limit — the whole
 *  clone would be right, just expensive — so a pane past it is copied as far as
 *  the budget reaches instead of being refused. A PR or review tab is the case
 *  that made this matter: a diff mounts a row of spans per line, so an ordinary
 *  hundred-line patch is already tens of thousands of elements, and an
 *  all-or-nothing cap turned every one of those tabs into a blank card with an
 *  icon in it. The top of a pane is a picture of the pane; nothing is a bug. */
export const PREVIEW_NODE_CAP = 6000;

/** Elements a clone must not carry.
 *
 *  `iframe`/`object`/`embed` would load their document a second time — a
 *  preview tab's page fetched again per tick is the kind of "thumbnail" that
 *  files a bug. `canvas`, `video` and `audio` clone as empty boxes (the bitmap
 *  and the stream belong to the original), so they'd draw a blank rectangle
 *  where content is; better to show the layout around them. `script` would run.
 *  `data-preview-skip` is the opt-out for anything else that dislikes being
 *  duplicated. */
const STRIP =
  "iframe,object,embed,canvas,video,audio,script,[data-preview-skip]";

/** How often the previews re-read, and how far the tick backs off when a pass
 *  costs more than it is worth. Live is the point — this is a stream of what
 *  each tab is doing, not a snapshot — so the base rate is fast and the backoff
 *  is what keeps 15 open tabs from turning a keypress into a stutter. */
export const PREVIEW_TICK_MS = 220;
export const PREVIEW_TICK_MAX_MS = 1600;
/** A pass may spend this long. Roughly a frame at 60Hz minus the compositing
 *  the scaled clones cost anyway. */
export const PREVIEW_BUDGET_MS = 12;

/** The next tick delay, given what the last pass cost. Doubling on an
 *  over-budget pass and halving on a cheap one means the rate finds the machine
 *  and the tab count instead of being guessed once here. */
export function nextTickMs(spentMs: number, current: number): number {
  if (spentMs > PREVIEW_BUDGET_MS)
    return Math.min(PREVIEW_TICK_MAX_MS, Math.round(current * 2));
  if (spentMs < PREVIEW_BUDGET_MS / 3)
    return Math.max(PREVIEW_TICK_MS, Math.round(current / 2));
  return current;
}

/** The last `maxLines` painted lines of a terminal capture, blank tail trimmed
 *  — what the thumbnail shows. Trailing blanks are what a shell leaves under
 *  its prompt, and keeping them would push the live part off the top. */
export function tailLines(text: string, maxLines: number): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(Math.max(0, lines.length - maxLines));
}

/** How many elements a pane holds, for the cap above. `querySelectorAll` is one
 *  native walk — cheaper than the clone it is deciding against. */
export function paneNodeCount(host: HTMLElement): number {
  return host.querySelectorAll("*").length;
}

/** As much of a pane as `budget` elements buys, in document order — the top of
 *  what the pane shows, which is the part a thumbnail has room for anyway.
 *
 *  A subtree that fits whole is taken with one native deep clone, which is the
 *  fast path and the common one; only the containers straddling the end of the
 *  budget are walked child by child. The walk stops the moment the budget runs
 *  out, so the cost of a preview no longer depends on how big the pane is. */
function cloneWithin(host: HTMLElement, budget: number): HTMLElement {
  const root = host.cloneNode(false) as HTMLElement;
  let left = budget;
  const fill = (src: Element, dst: Element) => {
    const kids = src.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (left <= 0) return;
      const node = kids[i];
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const size = paneNodeCount(el) + 1;
        if (size <= left) {
          dst.appendChild(el.cloneNode(true));
          left -= size;
          continue;
        }
        left -= 1;
        const shallow = el.cloneNode(false) as Element;
        dst.appendChild(shallow);
        fill(el, shallow);
      } else if (node.nodeType === Node.TEXT_NODE) {
        // Text is free: it is the content, and copying it costs no elements.
        dst.appendChild(node.cloneNode(false));
      }
    }
  };
  fill(host, root);
  return root;
}

/** A detached, inert copy of a pane, ready to be laid out at pane size and
 *  scaled — truncated to `cap` elements when the pane is bigger than that.
 *  Null when there is nothing worth showing: no host, or a host whose content
 *  lives somewhere this document can't see (a native webview's page). */
export function clonePane(
  host: HTMLElement | null | undefined,
  cap = PREVIEW_NODE_CAP,
): HTMLElement | null {
  if (!host) return null;
  const clone =
    paneNodeCount(host) > cap
      ? cloneWithin(host, cap)
      : (host.cloneNode(true) as HTMLElement);
  clone.querySelectorAll(STRIP).forEach((el) => el.remove());
  // A duplicated id makes `getElementById`, `aria-labelledby` and every `#id`
  // selector in the app ambiguous — the thumbnail would start answering
  // queries meant for the real pane.
  if (clone.id) clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.removeAttribute("data-tab-id");
  // The host's own hiding is what we are undoing: it is the thing carrying
  // `display: none` (or the visibility variant a proxy preview keeps).
  clone.style.display = "block";
  clone.style.position = "static";
  clone.style.visibility = "visible";
  clone.style.inset = "auto";
  clone.style.width = "100%";
  clone.style.height = "100%";
  clone.style.pointerEvents = "none";
  clone.setAttribute("aria-hidden", "true");
  // Nothing in a picture of a pane should be reachable: not by Tab, not by a
  // screen reader, not by a click that lands on a button that no longer means
  // anything.
  clone.setAttribute("inert", "");
  if (!clone.firstChild) return null;
  return clone;
}

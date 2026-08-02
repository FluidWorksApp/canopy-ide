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

/** Panes past this many elements aren't cloned. Not a correctness limit — the
 *  clone would be right, just expensive — and the fallback (icon and title) is
 *  what the switcher shows for a native webview anyway. A file tree with a
 *  large repo expanded, or a diff of a generated file, is what hits it. */
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

/** A detached, inert copy of a pane, ready to be laid out at pane size and
 *  scaled. Null when there is nothing worth showing: no host, a host too large
 *  to clone cheaply, or a host whose content lives somewhere this document
 *  can't see (a native webview's page). */
export function clonePane(
  host: HTMLElement | null | undefined,
  cap = PREVIEW_NODE_CAP,
): HTMLElement | null {
  if (!host) return null;
  if (paneNodeCount(host) > cap) return null;
  const clone = host.cloneNode(true) as HTMLElement;
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

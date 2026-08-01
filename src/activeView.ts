// What the user is looking at, as one channel.
//
// Three questions kept arriving separately and getting three different answers:
// which tab is in front, which project it belongs to, and whether a NATIVE view
// is claiming the pane — the last one mattering to everything that floats,
// because a child webview is composited above the whole window and an overlay
// on top of one makes the browser host blank the page rather than draw over it.
//
// Before this, each consumer answered them by reaching into whatever was
// nearest: the companion polled the browser layer's view snapshots on its own
// 400ms timer, the vault screen and the agent-ops bridge each ran their own
// `.find(v => v.wanted)`, and SpotSearch had the active tab handed down through
// props. Four readers, four spellings, four things to remember when a fifth
// surface needs to know. The companion's was also subtly the wrong question,
// and that one cost a permanently blank browser tab — see the note on
// `nativeTabId`.
//
// So: one channel. Each fact is pushed by the layer that owns it, at the moment
// it changes, and everything else subscribes.
//
//   * browserHost pushes `nativeTabId` from `apply()` — the pass that already
//     decides where every native view goes. Pushed at the point of change
//     rather than polled, so there is no interval, nothing to keep warm, and no
//     window in which a reader gets an answer from before the last tab switch.
//   * ProjectView pushes the tab in front, which is the only place that knows.
//
// Nothing reads this to make a decision the channel itself depends on. It is a
// notice board, not a participant.

import { createChannel, useChannel, useChannelSelect } from "./channel";
import type { SubTab } from "./components/ProjectView/helpers";

/** The tab kinds the app has, taken from the tab model rather than restated —
 *  a new kind of tab should never need a second edit here to be nameable. */
export type ActiveTabKind = SubTab["type"];

export interface ActiveView {
  /** The project whose pane is in front. */
  projectId: string | null;
  /** The tab in front of it, and what kind of thing it is. */
  tabId: string | null;
  kind: ActiveTabKind | null;
  /** The browser tab whose native view is claiming the pane, or null.
   *
   *  Non-null means a child webview is composited over the window here, so
   *  anything floating over the content area must UNMOUNT — not lower itself,
   *  not go transparent. A box that still paints is a box the host's occlusion
   *  walk finds, and its answer to being covered is to hide the page.
   *
   *  This is deliberately "a browser tab is in front and has room to draw",
   *  never "a native view is currently on screen". The second question is the
   *  host's CONCLUSION after looking for things painted over the view — so a
   *  surface that hid itself on it would be reading its own effect and
   *  concluding it could stay: mounted, it covers the view; the view goes down;
   *  nothing is on screen; it stays mounted. Both sides settled, and the page
   *  never came back. That is exactly what the companion did, and a browser tab
   *  was blank from its first frame until the companion was switched off. */
  nativeTabId: string | null;
}

const EMPTY: ActiveView = {
  projectId: null,
  tabId: null,
  kind: null,
  nativeTabId: null,
};

/** Cached identity matters: useSyncExternalStore re-renders whenever the
 *  snapshot is a new object, so `same` keeps the state from being replaced on
 *  anything but a real change. */
const board = createChannel<ActiveView>(EMPTY, {
  same: (a, b) =>
    a.projectId === b.projectId &&
    a.tabId === b.tabId &&
    a.kind === b.kind &&
    a.nativeTabId === b.nativeTabId,
});

export function activeView(): ActiveView {
  return board.get();
}

/** The tab in front, pushed by the visible ProjectView. */
export function setActiveTab(
  projectId: string,
  tabId: string | null,
  kind: ActiveTabKind | null,
) {
  board.set({ ...board.get(), projectId, tabId, kind });
}

/** A project's pane went away. Only clears if that project is still the one on
 *  record: several ProjectViews stay mounted at once and only the visible one
 *  publishes, so a hidden one tearing down must not wipe the entry the project
 *  that replaced it just wrote. Same shape as clearCaret in editorState. */
export function clearActiveTab(projectId: string) {
  if (board.get().projectId !== projectId) return;
  board.set({ ...board.get(), projectId: null, tabId: null, kind: null });
}

/** A browser tab is claiming a rectangle to draw a page in, or no longer is.
 *
 *  Pushed by browserHost's layout pass and by nothing else. Every other caller
 *  is a reader — routing a second writer through here would put the channel
 *  back to having several sources that can disagree. */
export function setNativeSurface(tabId: string | null) {
  board.set({ ...board.get(), nativeTabId: tabId });
}

export const subscribeActiveView = board.subscribe;

export function useActiveView(): ActiveView {
  return useChannel(board);
}

/** The one question everything that floats over the content area has to ask.
 *
 *  A hook of its own rather than `useActiveView().nativeTabId !== null` at each
 *  call site: this returns a boolean, so a surface that only cares whether to
 *  get out of the way does not re-render on every tab switch that doesn't
 *  change the answer. */
export function useNativeSurface(): boolean {
  return useChannelSelect(board, (v) => v.nativeTabId !== null);
}

/** Test seam: drop the board between cases. */
export function resetActiveView() {
  board.reset();
}

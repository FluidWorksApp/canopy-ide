// The Chromium engine's pane: a picture of a browser that has no window.
//
// The browser runs headless, so there is nothing to composite and nothing to
// hide — which is the whole reason it runs headless. What arrives instead is a
// JPEG stream over CDP, painted into an ordinary <img>. That makes the page an
// ordinary DOM element: a dialog covers it, a scroll clips it, and the elaborate
// occlusion machinery the child-webview engine needs (browserOcclusion.ts) does
// not apply here at all.
//
// It also means the pane works anywhere the frames can be sent, which the
// child-webview engine can never manage — a native view composited over this
// window has no meaning on the other end of Canopy Remote.

import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";

/** Chrome scales frames to the box it is given, so the cast is restarted when
 *  the pane changes size. Restarting on every pixel of a drag would be a
 *  command per frame, so movement is settled first. */
export const RESIZE_SETTLE_MS = 150;

/** Whether a size change is worth restarting the stream for. A pane drag emits
 *  hundreds of sizes; a frame stretched by a few pixels is invisible, and a
 *  restart mid-drag shows a gap. */
export function worthRecasting(
  from: { width: number; height: number } | null,
  to: { width: number; height: number },
): boolean {
  // Before the first-cast check, not after: a pane can be measured at zero
  // before it has ever been cast — mid-transition, or while its splitter is
  // collapsed — and asking Chrome for frames into a zero box is asking for
  // frames nobody will ever see.
  if (to.width < 1 || to.height < 1) return false;
  if (!from) return true;
  return Math.abs(from.width - to.width) >= 8 || Math.abs(from.height - to.height) >= 8;
}

/** Where a point in the displayed picture lands in the page.
 *
 *  This is what makes annotation work on this engine at all. The page is a
 *  headless browser streamed into an <img>, so the user's pointer is over a
 *  picture in Canopy's window and the page never sees a mouse — the host has to
 *  say "the click was at this page pixel" instead.
 *
 *  The <img> is object-fit: contain, so the picture is scaled to fit and
 *  centred, with letterboxing on whichever axis has slack. Ignoring that offset
 *  is the difference between annotating the element under the cursor and
 *  annotating one somewhere above and to the left of it.
 *
 *  Returns null for a point in the letterbox itself, which is outside the page
 *  and must not be reported as its nearest edge. */
export function paneToPage(
  point: { x: number; y: number },
  pane: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  if (page.width <= 0 || page.height <= 0 || pane.width <= 0 || pane.height <= 0) return null;
  // contain: one scale for both axes, the smaller of the two fits.
  const scale = Math.min(pane.width / page.width, pane.height / page.height);
  const shownWidth = page.width * scale;
  const shownHeight = page.height * scale;
  const left = (pane.width - shownWidth) / 2;
  const top = (pane.height - shownHeight) / 2;
  const x = (point.x - left) / scale;
  const y = (point.y - top) / scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x, y };
}

/** The latest frame for a tab, and the cast lifecycle that keeps it coming.
 *
 *  `active` is the tab being in front. A backgrounded tab stops its stream
 *  rather than pausing it: Chrome keeps encoding for a stopped-reading consumer,
 *  and a dozen background tabs each encoding JPEGs is a laptop fan. */
export function useChromiumFrame(tabId: string, active: boolean) {
  const [frame, setFrame] = useState<string | null>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  /** The page's own viewport, needed to map a click in the picture back to a
   *  point in the page. Re-asked on navigation, because a new document can lay
   *  out at a different size. */
  const page = useRef<{ width: number; height: number } | null>(null);

  const measurePage = async () => {
    const m = (await ipc.chromiumMetrics(tabId).catch(() => null)) as
      | { w?: number; h?: number }
      | null;
    if (m?.w && m?.h) page.current = { width: m.w, height: m.h };
  };

  useEffect(() => {
    if (!active) return;
    void measurePage();
    let live = true;
    const un = ipc.onChromiumNav((e) => {
      if (live && e.tabId === tabId) void measurePage();
    });
    return () => {
      live = false;
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, active]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const un = ipc.onChromiumFrame((e) => {
      if (live && e.tabId === tabId) setFrame(e.frame);
    });
    return () => {
      live = false;
      void un.then((f) => f());
    };
  }, [tabId, active]);

  useEffect(() => {
    if (!active) {
      void ipc.chromiumStopCast(tabId);
      // Deliberately NOT cleared: the last frame is what the tab shows the
      // instant it comes back, instead of a blank pane for one round trip.
      size.current = null;
      return;
    }
    return () => void ipc.chromiumStopCast(tabId);
  }, [tabId, active]);

  /** Called by the pane with its measured box. Starts the cast the first time
   *  and re-sizes it when the pane genuinely changed shape. */
  const fit = (box: { width: number; height: number }) => {
    if (!active || !worthRecasting(size.current, box)) return;
    size.current = box;
    void ipc
      .chromiumStartCast(tabId, Math.round(box.width), Math.round(box.height))
      .catch(() => {
        // The browser isn't up yet — the pane measures itself before the tab
        // has opened. Forget the size, so the render that follows the open
        // retries instead of believing a cast is already running.
        size.current = null;
      });
  };

  /** Tell the page where the pointer is, and whether that is a pick.
   *
   *  This is annotate mode on this engine. The page cannot see the mouse, so
   *  the host translates the event and the picker resolves the element by
   *  coordinate — which also means the page's own handlers never fire, so
   *  annotating a link cannot navigate away from the thing being annotated. */
  const pointAt = (host: Element, ev: { clientX: number; clientY: number }, commit: boolean) => {
    if (!page.current) return;
    const box = host.getBoundingClientRect();
    const at = paneToPage(
      { x: ev.clientX - box.left, y: ev.clientY - box.top },
      { width: box.width, height: box.height },
      page.current,
    );
    if (!at) return; // in the letterbox: outside the page entirely
    void ipc.chromiumCommand(tabId, { canopy: "pick-at", x: at.x, y: at.y, commit });
  };

  return { frame, fit, pointAt };
}

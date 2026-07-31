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

/** The latest frame for a tab, and the cast lifecycle that keeps it coming.
 *
 *  `active` is the tab being in front. A backgrounded tab stops its stream
 *  rather than pausing it: Chrome keeps encoding for a stopped-reading consumer,
 *  and a dozen background tabs each encoding JPEGs is a laptop fan. */
export function useChromiumFrame(tabId: string, active: boolean) {
  const [frame, setFrame] = useState<string | null>(null);
  const size = useRef<{ width: number; height: number } | null>(null);

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
    void ipc.chromiumStartCast(tabId, Math.round(box.width), Math.round(box.height));
  };

  return { frame, fit };
}

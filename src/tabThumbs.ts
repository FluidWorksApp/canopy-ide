// The last picture taken of each preview tab's page, for the tab hover card and
// the switcher. A preview's page is an iframe, which a thumbnail's DOM clone
// cannot carry (tabPreview.ts strips it so the page is not loaded twice), so the
// page is photographed while it is in front and the picture kept here.

const shots = new Map<string, string>();
const listeners = new Set<() => void>();

/** A PNG data URL, or null when the tab has never been photographed. */
export function tabThumb(tabId: string): string | null {
  return shots.get(tabId) ?? null;
}

export function setTabThumb(tabId: string, pngBase64: string): void {
  if (!pngBase64) return;
  shots.set(tabId, `data:image/png;base64,${pngBase64}`);
  for (const l of listeners) l();
}

export function forgetTabThumb(tabId: string): void {
  if (shots.delete(tabId)) for (const l of listeners) l();
}

export function subscribeTabThumbs(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** True while something floats over the window that a capture would bake into
 *  the picture: the hover card, the switcher, an open menu. */
export function overlayOpen(doc: Document = document): boolean {
  return !!doc.querySelector(".tab-hover-preview, .tsw-card, [role=menu]");
}

/** Capture width: about twice the card, so it stays sharp on a retina screen. */
export const THUMB_CAPTURE_W = 480;
/** First capture after a load settles, then a slow refresh while in front. */
export const THUMB_FIRST_MS = 1500;
export const THUMB_EVERY_MS = 12_000;

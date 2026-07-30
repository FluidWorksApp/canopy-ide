// Where a clicked link goes.
//
// One function, because the alternative is what this replaced: every view that
// renders text with a URL in it deciding for itself, and the ones nobody thought
// of behaving differently from the ones somebody did. A link in a commit message
// is a link in an issue body is a link in a terminal.
//
// Two destinations. A preview tab in the project you are in — Canopy has a real
// browser in it, and staying inside the app is almost always what you meant — or
// the OS browser, when you have said you prefer that (Settings → Browser) or
// when nothing internal can take it. That last case matters more than it looks:
// a link that silently does nothing is worse than a link that opens in the wrong
// place, so the fallback is unconditional.
//
// Only http(s). Every other scheme is refused rather than passed on: a
// `javascript:` or `file:` href in an issue body or a converted document is a
// free script execution or a local read, and neither destination should be asked
// to decide that.

import { getSettings } from "./settings";

/** Asked of whichever project view is in front. Cancelling it means "I have
 *  taken this URL"; nobody cancelling means there was no view to take it. */
export const OPEN_URL_EVENT = "canopy:open-url";

export interface OpenUrlDetail {
  url: string;
}

function toOsBrowser(url: string) {
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
}

/** Follow a link the user clicked. Safe to call with anything — a non-http
 *  scheme is dropped, not forwarded. */
export function openLink(href: string) {
  if (!/^https?:\/\//i.test(href)) return;
  if (getSettings().openLinksInApp) {
    const claimed = !window.dispatchEvent(
      new CustomEvent<OpenUrlDetail>(OPEN_URL_EVENT, {
        detail: { url: href },
        cancelable: true,
      }),
    );
    if (claimed) return;
  }
  toOsBrowser(href);
}

/** For the controls that promise to leave — Support, Open on GitHub, filing an
 *  issue. Named so that reading the call site tells you it meant to. */
export function openInOsBrowser(url: string) {
  toOsBrowser(url);
}

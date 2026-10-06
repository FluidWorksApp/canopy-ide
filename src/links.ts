// Where a clicked link goes.
//
// One function, because the alternative is what this replaced: every view that
// renders text with a URL in it deciding for itself, and the ones nobody thought
// of behaving differently from the ones somebody did. A link in a commit message
// is a link in an issue body is a link in a terminal.
//
// Two destinations. A plain click opens a preview tab in the project you are in;
// a command-click opens the OS browser. When nothing internal can take a plain
// click, it falls back to the OS browser. That last case matters more than it looks:
// a link that silently does nothing is worse than a link that opens in the wrong
// place, so the fallback is unconditional.
//
// Only http(s). Every other scheme is refused rather than passed on: a
// `javascript:` or `file:` href in an issue body or a converted document is a
// free script execution or a local read, and neither destination should be asked
// to decide that.

/** Asked of whichever project view is in front. Cancelling it means "I have
 *  taken this URL"; nobody cancelling means there was no view to take it. */
export const OPEN_URL_EVENT = "canopy:open-url";
export const OPEN_FILE_EVENT = "canopy:open-file";

export interface OpenUrlDetail {
  url: string;
}

export interface OpenFileDetail {
  path: string;
  line?: number;
  cwd?: string;
}

function toOsBrowser(url: string) {
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
}

/** Follow a link the user clicked. Safe to call with anything — a non-http
 *  scheme is dropped, not forwarded. */
export function openLink(href: string, external = false) {
  if (!/^https?:\/\//i.test(href)) return;
  // Provider logins must leave the preview and return to the owning VM.
  if (/^https:\/\/(auth\.openai\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)\//i.test(href) && new URL(href).searchParams.has('redirect_uri')) {
    void import('./host').then(async ({isRemoteHost}) => {
      if (isRemoteHost()) {
        const {invoke} = await import('@tauri-apps/api/core');
        await invoke('execution_remote_login_prepare',{url:href});
      }
      toOsBrowser(href);
    }).catch(() => window.dispatchEvent(new CustomEvent('canopy:remote-login-error',{detail:'Could not forward the sign-in callback. The local port may already be in use. Finish the other sign-in or use device-code login.'})));
    return;
  }
  if (/^https:\/\/github\.com\/login\/device(?:[/?#]|$)/i.test(href)) {toOsBrowser(href);return;}
  if (!external) {
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

/** Ask the visible project to open an absolute terminal path. */
export function openFileLink(path: string, line?: number, cwd?: string) {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path)) return;
  window.dispatchEvent(
    new CustomEvent<OpenFileDetail>(OPEN_FILE_EVENT, {
      detail: { path, line, cwd },
      cancelable: true,
    }),
  );
}

/** For the controls that promise to leave — Support, Open on GitHub, filing an
 *  issue. Named so that reading the call site tells you it meant to. */
export function openInOsBrowser(url: string) {
  toOsBrowser(url);
}

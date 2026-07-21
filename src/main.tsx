import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { monacoReady } from "./monaco-setup";
import { applyTheme, getSettings, watchSystemTheme } from "./settings";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Before first paint, so there's no flash of the wrong palette.
applyTheme(getSettings().theme, getSettings().customAccent);
// Keep Auto tracking the OS day/night flip for the whole app lifetime.
watchSystemTheme();

// Surface WebView errors in the dev terminal (Rust log).
const jsLog = (level: string, message: string) =>
  void invoke("js_log", { level, message }).catch(() => {});
// The webview's native context menu belongs to a browser, not an IDE: it offers
// Reload / Inspect Element, or macOS's Look Up / Translate / Search with Google
// over selected text. Suppress it everywhere except real text inputs, where the
// system clipboard menu is genuinely what you want. Components that have their
// own menu (the file tree) call preventDefault themselves and open it.
window.addEventListener(
  "contextmenu",
  (e) => {
    const t = e.target as HTMLElement | null;
    const editable =
      t?.closest("input, textarea, [contenteditable='true'], .monaco-editor, .xterm") != null;
    if (!editable) e.preventDefault();
  },
  { capture: true },
);


// Every http(s) link in the app opens in the real browser, wherever it lives:
// issue bodies, commit messages, PR descriptions, rendered markdown, anything
// added later. Delegated once here rather than per-view — a webview has
// nowhere to navigate back from, so a link that "works" by replacing the app
// is worse than one that does nothing, and solving it per view is how some
// get forgotten (commit messages had).
window.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!href) return;
  // Cancel FIRST, for every scheme. Returning early on a non-http href left
  // the webview to navigate it itself — and `javascript:` or `file:` in an
  // issue body or a converted document is then a free script execution or a
  // local read. Only http(s) goes on to the OS browser.
  e.preventDefault();
  if (!/^https?:\/\//i.test(href)) return;
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
});

window.addEventListener("error", (e) =>
  jsLog("error", `${e.message} @ ${e.filename}:${e.lineno}`),
);
window.addEventListener("unhandledrejection", (e) =>
  jsLog("error", `unhandled rejection: ${e.reason}`),
);
jsLog("info", "webview booting");
// Reap PTY sessions orphaned by a previous page of this webview (reloads
// destroy JS state without running React cleanup).
void invoke("pty_kill_all").catch(() => {});

// Wait for the monaco-vscode-api services barrier before mounting — editor and
// model calls queue behind it. If it fails we still mount: the terminal (the
// heart of the app) works without Monaco.
// No StrictMode: its dev-mode double-mount would spawn and kill a real PTY for
// every terminal on each mount, which churns native child processes.
monacoReady
  .then(() => jsLog("info", "monaco services initialized"))
  .catch((err) => jsLog("error", `monaco services failed to initialize: ${err}`))
  .finally(() => {
    createRoot(document.getElementById("root")!).render(
      <ErrorBoundary label="Canopy">
        <App />
      </ErrorBoundary>,
    );
    jsLog("info", "app mounted");
  });

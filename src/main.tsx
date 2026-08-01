import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
// Bundled, not fetched: this is a desktop app that has to look the same on a
// machine with no network and no fonts installed. Variable weight axis only —
// one file per subset covers 100–900, so the four weights the Vitrine skin
// uses cost no more than one would. Each @font-face carries a unicode-range,
// so a session that never types Cyrillic never loads the Cyrillic file.
// Referenced by --font-ui/--font-mono; see src/skins/vitrine.css.
import "@fontsource-variable/archivo/wght.css";
import "@fontsource-variable/jetbrains-mono/index.css";
// The Pixel skin's voice. Single weight, latin only, and a few KB — an 8-bit
// skin whose type fell back to the system sans would be the one thing in it
// that isn't 8-bit. Press Start 2P was here too and is gone: it is a display
// face 2x the sans's advance, which broke every row it touched. See
// src/skins/pixel.css.
import "@fontsource/vt323/index.css";
import "./index.css";
import { monacoReady } from "./monaco-setup";
import { applyTheme, getSettings, watchSystemTheme } from "./settings";
import { openLink } from "./links";
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


// Every http(s) link in the app is followed through links.ts, wherever it
// lives: issue bodies, commit messages, PR descriptions, rendered markdown,
// anything added later. Delegated once here rather than per-view — a webview has
// nowhere to navigate back from, so a link that "works" by replacing the app is
// worse than one that does nothing, and solving it per view is how some get
// forgotten (commit messages had).
window.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!href) return;
  // Cancel FIRST, for every scheme. Returning early on a non-http href left
  // the webview to navigate it itself — and `javascript:` or `file:` in an
  // issue body or a converted document is then a free script execution or a
  // local read. openLink refuses everything but http(s).
  e.preventDefault();
  openLink(href);
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
// A native panic from a previous run parks a report on disk; flush it now if
// the user is opted in (the backend clears it either way, so it's offered once).
void import("./crash").then(({ flushPendingCrash }) => flushPendingCrash());

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

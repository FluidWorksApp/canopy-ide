import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { monacoReady } from "./monaco-setup";
import { applyAppearance } from "./themes";
import App from "./App.tsx";

// Theme before first paint — App's effect would flash dark at light users.
applyAppearance();

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
    createRoot(document.getElementById("root")!).render(<App />);
    jsLog("info", "app mounted");
  });

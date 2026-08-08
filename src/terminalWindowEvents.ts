import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { INSERT_TEXT_EVENT } from "./insertText";
import { THEME_CHANGE_EVENT } from "./settings";

export interface TerminalWindowEventTarget {
  active: () => boolean;
  focus: () => void;
  insertText: (text: string) => void;
  dropPaths: (paths: string[]) => void;
  themeChanged: () => void;
}

const targets = new Set<TerminalWindowEventTarget>();
let listening = false;
let dropUnlisten: (() => void) | undefined;
let dropInstall: Promise<void> | undefined;
let dropRetryTimer: ReturnType<typeof setTimeout> | undefined;
const DROP_RETRY_MS = 1_000;

const activeTarget = () => {
  for (const target of targets) {
    if (target.active()) return target;
  }
  return undefined;
};

const onFocus = () => activeTarget()?.focus();
const onInsertText = (event: Event) => {
  const text = (event as CustomEvent).detail;
  if (typeof text === "string" && text) activeTarget()?.insertText(text);
};
const onThemeChange = () => {
  for (const target of targets) target.themeChanged();
};

const installDropListener = () => {
  if (dropInstall || dropUnlisten) return;
  dropInstall = getCurrentWebviewWindow()
    .onDragDropEvent((event) => {
      if (event.payload.type !== "drop" || !event.payload.paths.length) return;
      activeTarget()?.dropPaths(event.payload.paths);
    })
    .then((unlisten) => {
      if (targets.size === 0) unlisten();
      else dropUnlisten = unlisten;
    })
    .catch(() => {
      // Losing native drop support must not become an unhandled rejection or
      // affect terminal streaming. Keep at most one bounded retry timer for
      // the current owners rather than requiring every terminal to unmount.
      if (targets.size > 0 && listening && dropRetryTimer == null) {
        dropRetryTimer = setTimeout(() => {
          dropRetryTimer = undefined;
          if (targets.size > 0 && listening) installDropListener();
        }, DROP_RETRY_MS);
      }
    })
    .finally(() => {
      dropInstall = undefined;
    });
};

const start = () => {
  if (listening) return;
  listening = true;
  window.addEventListener("focus", onFocus);
  window.addEventListener(INSERT_TEXT_EVENT, onInsertText);
  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
  installDropListener();
};

const stop = () => {
  if (!listening) return;
  listening = false;
  window.removeEventListener("focus", onFocus);
  window.removeEventListener(INSERT_TEXT_EVENT, onInsertText);
  window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  dropUnlisten?.();
  dropUnlisten = undefined;
  clearTimeout(dropRetryTimer);
  dropRetryTimer = undefined;
};

/**
 * One renderer-global listener set routes window input to the single active
 * terminal. Hidden terminals retain no Tauri drop closure or DOM-global event
 * subscriptions of their own.
 */
export function registerTerminalWindowEvents(target: TerminalWindowEventTarget) {
  targets.add(target);
  start();
  return () => {
    targets.delete(target);
    if (targets.size === 0) stop();
  };
}

export const terminalWindowEventMetrics = () => ({
  targets: targets.size,
  domListenerSets: listening ? 1 : 0,
  tauriDropListeners: dropUnlisten ? 1 : 0,
  tauriDropListenerPending: dropInstall ? 1 : 0,
  tauriDropRetryPending: dropRetryTimer ? 1 : 0,
});

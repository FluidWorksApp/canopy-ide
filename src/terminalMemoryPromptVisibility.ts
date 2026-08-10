import {
  getSettings,
  SETTINGS_CHANGE_EVENT,
} from "./settings";

const WINDOW_DISMISSAL_KEY = "canopy.terminalMemoryPrompts.dismissedWindow.v1";
const WINDOW_DISMISSAL_EVENT = "canopy:terminal-memory-prompts-dismissed";

const dismissedForWindow = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(WINDOW_DISMISSAL_KEY) === "1";
  } catch {
    // A locked-down webview can deny storage. Keep the safety prompt available
    // rather than making a failed persistence call silently disable it.
    return false;
  }
};

/** One authority for both memory surfaces: the persistent Settings choice and
 * the current-window dismissal must never let one card outlive the other. */
export const terminalMemoryPromptsVisible = (): boolean =>
  getSettings().terminalMemoryPromptsEnabled && !dismissedForWindow();

/** “Decide later” and the flyout close button both mean later than this app
 * window. sessionStorage is scoped to that window and is cleared when it is
 * closed, unlike the persistent preference in Settings. */
export function dismissTerminalMemoryPromptsForWindow(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(WINDOW_DISMISSAL_KEY, "1");
  } catch {
    // Still notify live subscribers. The dismissal remains effective for the
    // current render; a storage-denied reload may show the prompt again.
  }
  window.dispatchEvent(new Event(WINDOW_DISMISSAL_EVENT));
}

export function subscribeTerminalMemoryPromptVisibility(
  callback: () => void,
): () => void {
  window.addEventListener(SETTINGS_CHANGE_EVENT, callback);
  window.addEventListener(WINDOW_DISMISSAL_EVENT, callback);
  return () => {
    window.removeEventListener(SETTINGS_CHANGE_EVENT, callback);
    window.removeEventListener(WINDOW_DISMISSAL_EVENT, callback);
  };
}

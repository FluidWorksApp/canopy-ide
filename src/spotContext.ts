// What "this page" means when SpotSearch's Run Task fires: the tab in front of
// the user, their caret and selection, the visible tail of the active terminal,
// and — where the platform can (webview snapshots are macOS-only today) — a
// screenshot of the pane, saved under the workspace so the agent's own file
// tools can read it back. Composed into a single one-line brief, because a PTY
// prompt is one line (see microTasks.oneLine).
import * as ipc from "./ipc";
import { getCaret } from "./editorState";
import { describeTab, type SubTab } from "./components/ProjectView/helpers";
import { oneLine } from "./microTasks";

/** Bounded slices — the brief is context, not a transcript dump. */
const MAX_SELECTION = 600;
const MAX_TERMINAL = 800;

export interface SpotCaptureInput {
  activeTab: SubTab | undefined;
  /** Where to save the screenshot (a registered workspace root). */
  dir: string;
  /** Visible text of the active terminal, when the active tab is one. */
  termText?: string;
  /** The pane's on-screen rectangle, captured AFTER the palette has closed —
   *  a snapshot taken under the open palette is a picture of the palette. */
  rect?: { x: number; y: number; width: number; height: number } | null;
}

/** Build the context half of a run-task brief. Never throws: every part that
 *  can fail (the screenshot, chiefly) degrades to absence instead. */
export async function capturePageContext(input: SpotCaptureInput): Promise<string> {
  const parts: string[] = [];
  const desc = describeTab(input.activeTab);
  if (desc) {
    const label = "path" in desc && desc.path ? desc.path : ("label" in desc ? (desc.label ?? "") : "");
    parts.push(`The user is looking at: ${desc.kind}${label ? ` ${label}` : ""}.`);
  }
  const caret = getCaret();
  if (caret && input.activeTab?.type === "file") {
    parts.push(`Caret at ${caret.path}:${caret.line}:${caret.column}.`);
    if (caret.selection) {
      parts.push(
        `Selected text: "${caret.selection.slice(0, MAX_SELECTION)}".`,
      );
    }
  }
  if (input.termText?.trim()) {
    parts.push(
      `Visible terminal output (tail): "${input.termText.trim().slice(-MAX_TERMINAL)}".`,
    );
  }
  if (input.rect && input.rect.width > 0 && input.rect.height > 0) {
    try {
      const png = await capturePixels(input);
      const path = await ipc.spotSaveContextImage(input.dir, png);
      parts.push(
        `A screenshot of the page is saved at ${path} — read it if visual context helps.`,
      );
    } catch {
      // Non-macOS, or a snapshot that failed — the text context stands alone.
    }
  }
  return oneLine(parts.join(" "));
}

/** The pixels of the pane, base64 PNG. A preview tab's page lives in a native
 *  child webview composited over the app's DOM — a rect capture of the main
 *  webview there is a picture of the empty placeholder underneath it — so
 *  preview tabs are asked through the browser view's own snapshot first, and
 *  the rect capture stands as the fallback for the proxy engine (an iframe in
 *  the main webview) and for every other kind of tab. */
export async function capturePixels(input: SpotCaptureInput): Promise<string> {
  const rect = input.rect!;
  if (input.activeTab?.type === "preview") {
    try {
      return await ipc.browserSnapshot(input.activeTab.id, 1400);
    } catch {
      // No native view behind this tab (proxy engine) — fall through.
    }
  }
  return ipc.webviewSnapshot(rect.x, rect.y, rect.width, rect.height, 1400);
}

/** The full brief for the one-shot agent: what the user typed, grounded in
 *  what they were looking at. */
export function composeTaskBrief(userTask: string, context: string): string {
  const task = oneLine(userTask);
  if (!context) return task;
  return `${task} — Context from the page the user launched this from: ${context}`;
}

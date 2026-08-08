import {
  previewFeedbackContext,
  previewShotContext,
  type PreviewAnnotation,
  type PreviewServer,
  type PreviewShot,
} from "./preview";
import type { CaptureMode } from "./pageCapture";

/** The active Build preview's controls and retained visual context.
 *
 * PreviewView owns the durable tab state. The title bar and Ash island are
 * merely two projections of it, so this bridge carries callbacks rather than
 * introducing a second annotation store that could drift from the page. */
export interface VibePreviewContext {
  projectId: string;
  tabId: string;
  url: string;
  server: PreviewServer | null;
  annotations: PreviewAnnotation[];
  shots: PreviewShot[];
  picking: boolean;
  capturing: boolean;
  captureMode: CaptureMode;
  go: (delta: -1 | 0 | 1) => void;
  navigate: (url: string) => void;
  togglePicking: () => void;
  capture: (mode: CaptureMode) => void;
  setAnnotationComment: (n: number, comment: string) => void;
  removeAnnotation: (n: number) => void;
  clearAnnotations: () => void;
  setShotNote: (n: number, note: string) => void;
  removeShot: (n: number) => void;
  clearShots: () => void;
  markSent: (annotations: PreviewAnnotation[], shots: PreviewShot[]) => void;
}

const active = new Map<string, VibePreviewContext>();
const listeners = new Map<string, Set<() => void>>();

const notify = (projectId: string) => {
  for (const listener of listeners.get(projectId) ?? []) listener();
};

export function publishVibePreviewContext(context: VibePreviewContext): void {
  active.set(context.projectId, context);
  notify(context.projectId);
}

export function removeVibePreviewContext(projectId: string, tabId: string): void {
  if (active.get(projectId)?.tabId !== tabId) return;
  active.delete(projectId);
  notify(projectId);
}

export function getVibePreviewContext(projectId: string): VibePreviewContext | null {
  return active.get(projectId) ?? null;
}

export function subscribeVibePreviewContext(
  projectId: string,
  listener: () => void,
): () => void {
  let projectListeners = listeners.get(projectId);
  if (!projectListeners) {
    projectListeners = new Set();
    listeners.set(projectId, projectListeners);
  }
  projectListeners.add(listener);
  return () => {
    projectListeners?.delete(listener);
    if (projectListeners?.size === 0) listeners.delete(projectId);
  };
}

/** Context appended behind the user's words for an ordinary Build turn.
 * Sent items stay visible in the island as history, but only pending items are
 * handed to Ash again. */
export function vibePreviewBrief(context: VibePreviewContext | null): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.annotations.some((annotation) => !annotation.sent)) {
    parts.push(previewFeedbackContext(context.url, context.annotations, context.server));
  }
  if (context.shots.some((shot) => !shot.sent)) {
    parts.push(previewShotContext(context.url, context.shots, context.server));
  }
  return parts.join(" ");
}

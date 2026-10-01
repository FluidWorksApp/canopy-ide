import { releaseHiddenBrowserFrames } from "./browserHost";
import { rendererIoBudget } from "./ioBudget";
import { shedInactiveEditorModels } from "./editorModelRetention";
import { shedInactiveViewerBytes } from "./viewerByteRetention";

export interface RendererPressureReliefResult {
  level: number;
  terminalsScheduled: number;
  browserFramesReleased: number;
  browserFrameBytesReleased: number;
  editorModelsScheduled: number;
  viewerBytesScheduled: number;
}

const terminalShedders = new Set<() => boolean>();
let last: RendererPressureReliefResult = {
  level: 0,
  terminalsScheduled: 0,
  browserFramesReleased: 0,
  browserFrameBytesReleased: 0,
  editorModelsScheduled: 0,
  viewerBytesScheduled: 0,
};

export function registerTerminalPressureShedder(
  shed: () => boolean,
): () => void {
  terminalShedders.add(shed);
  return () => terminalShedders.delete(shed);
}

/** Release only reconstructable renderer state. Visible terminals, live pages,
 * models, and unsaved text are never destroyed here. */
export function shedRendererPressure(level: number): RendererPressureReliefResult {
  rendererIoBudget.setHostPressure(level);
  if (level <= 0) {
    last = {
      level: 0,
      terminalsScheduled: 0,
      browserFramesReleased: 0,
      browserFrameBytesReleased: 0,
      editorModelsScheduled: 0,
      viewerBytesScheduled: 0,
    };
    return last;
  }
  let terminalsScheduled = 0;
  for (const shed of terminalShedders) {
    try {
      if (shed()) terminalsScheduled += 1;
    } catch {
      // One concurrently disposed terminal must not block its peers.
    }
  }
  const frames = releaseHiddenBrowserFrames();
  const editorModelsScheduled = shedInactiveEditorModels();
  const viewerBytes = shedInactiveViewerBytes();
  last = {
    level,
    terminalsScheduled,
    browserFramesReleased: frames.frames,
    browserFrameBytesReleased: frames.bytes,
    editorModelsScheduled,
    viewerBytesScheduled: viewerBytes.bytes,
  };
  return last;
}

export function rendererPressureReliefMetrics(): RendererPressureReliefResult {
  return { ...last };
}

export function resetRendererPressureReliefForTest(): void {
  rendererIoBudget.setHostPressure(0);
  terminalShedders.clear();
  last = {
    level: 0,
    terminalsScheduled: 0,
    browserFramesReleased: 0,
    browserFrameBytesReleased: 0,
    editorModelsScheduled: 0,
    viewerBytesScheduled: 0,
  };
}

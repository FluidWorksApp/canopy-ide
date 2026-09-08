import { beforeEach, describe, expect, it, vi } from "vitest";

const { releaseHiddenBrowserFrames } = vi.hoisted(() => ({
  releaseHiddenBrowserFrames: vi.fn(() => ({ frames: 2, bytes: 4096 })),
}));
const { shedInactiveEditorModels } = vi.hoisted(() => ({
  shedInactiveEditorModels: vi.fn(() => 3),
}));
const { shedInactiveViewerBytes } = vi.hoisted(() => ({
  shedInactiveViewerBytes: vi.fn(() => ({ viewers: 2, bytes: 8192 })),
}));
vi.mock("./browserHost", () => ({ releaseHiddenBrowserFrames }));
vi.mock("./editorModelRetention", () => ({ shedInactiveEditorModels }));
vi.mock("./viewerByteRetention", () => ({ shedInactiveViewerBytes }));

import {
  registerTerminalPressureShedder,
  rendererPressureReliefMetrics,
  resetRendererPressureReliefForTest,
  shedRendererPressure,
} from "./rendererPressureRelief";

describe("renderer pressure relief", () => {
  beforeEach(() => {
    resetRendererPressureReliefForTest();
    releaseHiddenBrowserFrames.mockClear();
  });

  it("sheds every safe hidden owner and records scalar results", () => {
    registerTerminalPressureShedder(() => true);
    registerTerminalPressureShedder(() => false);
    registerTerminalPressureShedder(() => {
      throw new Error("disposed concurrently");
    });
    expect(shedRendererPressure(2)).toEqual({
      level: 2,
      terminalsScheduled: 1,
      browserFramesReleased: 2,
      browserFrameBytesReleased: 4096,
      editorModelsScheduled: 3,
      viewerBytesScheduled: 8192,
    });
    expect(rendererPressureReliefMetrics()).toEqual({
      level: 2,
      terminalsScheduled: 1,
      browserFramesReleased: 2,
      browserFrameBytesReleased: 4096,
      editorModelsScheduled: 3,
      viewerBytesScheduled: 8192,
    });
  });

  it("does not shed during a recovery-to-normal transition", () => {
    const terminal = vi.fn(() => true);
    registerTerminalPressureShedder(terminal);
    expect(shedRendererPressure(0).level).toBe(0);
    expect(terminal).not.toHaveBeenCalled();
    expect(releaseHiddenBrowserFrames).not.toHaveBeenCalled();
  });
});

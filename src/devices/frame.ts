// Ported from T3 Code packages/client-runtime/src/device/frame.ts
// (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License, Copyright (c) 2026 T3 Tools Inc.).
// Unchanged from T3.
/** A synchronous, borrowed frame. The producer releases its source after present returns. */
export interface DeviceFrameSink {
  readonly present: (source: CanvasImageSource, width: number, height: number) => boolean;
}

export function createCanvasFrameSink(
  canvas: HTMLCanvasElement,
  onFrame?: (width: number, height: number) => void,
): DeviceFrameSink {
  return {
    present(source, width, height) {
      const context = canvas.getContext("2d");
      if (!context) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      onFrame?.(width, height);
      return true;
    },
  };
}

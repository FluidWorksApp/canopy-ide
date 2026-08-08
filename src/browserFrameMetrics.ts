/**
 * Constant-size accounting for browser freeze frames owned by the renderer.
 *
 * Native snapshot metrics end when the encoded payload crosses IPC. This
 * ledger covers the next ownership boundary: image decode and the Blob bytes
 * retained by the frontend. It deliberately stores no tab ids, URLs, image
 * contents, or per-capture history, so observing a long soak cannot itself
 * become a retention source.
 */
export interface BrowserFrameMetrics {
  decode_count: number;
  decode_total_ms: number;
  decode_last_ms: number;
  decode_max_ms: number;
  decode_average_ms: number;
  retained_frames: number;
  retained_blob_bytes: number;
  retained_frames_high_water: number;
  retained_blob_bytes_high_water: number;
}

const state = {
  decodeCount: 0,
  decodeTotalMs: 0,
  decodeLastMs: 0,
  decodeMaxMs: 0,
  retainedFrames: 0,
  retainedBlobBytes: 0,
  retainedFramesHighWater: 0,
  retainedBlobBytesHighWater: 0,
};

/** Record one decoded replacement and transfer ownership from the old frame. */
export function adoptBrowserFrame(
  previousBytes: number,
  nextBytes: number,
  decodeMs: number,
): void {
  state.decodeCount += 1;
  state.decodeLastMs = Math.max(0, decodeMs);
  state.decodeTotalMs += state.decodeLastMs;
  state.decodeMaxMs = Math.max(state.decodeMaxMs, state.decodeLastMs);

  if (previousBytes <= 0) state.retainedFrames += 1;
  state.retainedBlobBytes = Math.max(
    0,
    state.retainedBlobBytes - Math.max(0, previousBytes) + Math.max(0, nextBytes),
  );
  state.retainedFramesHighWater = Math.max(
    state.retainedFramesHighWater,
    state.retainedFrames,
  );
  state.retainedBlobBytesHighWater = Math.max(
    state.retainedBlobBytesHighWater,
    state.retainedBlobBytes,
  );
}

/** Release one adopted frame. Stale, never-adopted captures are not counted. */
export function releaseBrowserFrame(bytes: number): void {
  if (bytes <= 0) return;
  state.retainedFrames = Math.max(0, state.retainedFrames - 1);
  state.retainedBlobBytes = Math.max(0, state.retainedBlobBytes - bytes);
}

export function browserFrameMetrics(): BrowserFrameMetrics {
  return {
    decode_count: state.decodeCount,
    decode_total_ms: state.decodeTotalMs,
    decode_last_ms: state.decodeLastMs,
    decode_max_ms: state.decodeMaxMs,
    decode_average_ms:
      state.decodeCount === 0 ? 0 : state.decodeTotalMs / state.decodeCount,
    retained_frames: state.retainedFrames,
    retained_blob_bytes: state.retainedBlobBytes,
    retained_frames_high_water: state.retainedFramesHighWater,
    retained_blob_bytes_high_water: state.retainedBlobBytesHighWater,
  };
}

/** Test/reset seam; production lifecycle releases individual owners. */
export function resetBrowserFrameMetrics(): void {
  state.decodeCount = 0;
  state.decodeTotalMs = 0;
  state.decodeLastMs = 0;
  state.decodeMaxMs = 0;
  state.retainedFrames = 0;
  state.retainedBlobBytes = 0;
  state.retainedFramesHighWater = 0;
  state.retainedBlobBytesHighWater = 0;
}

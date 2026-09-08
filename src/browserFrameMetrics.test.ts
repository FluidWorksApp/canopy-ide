import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptBrowserFrame,
  browserFrameMetrics,
  releaseBrowserFrame,
  resetBrowserFrameMetrics,
} from "./browserFrameMetrics";

describe("browser frame renderer metrics", () => {
  beforeEach(resetBrowserFrameMetrics);

  it("accounts replacement ownership without retaining per-frame history", () => {
    adoptBrowserFrame(0, 300, 12);
    adoptBrowserFrame(300, 450, 8);

    expect(browserFrameMetrics()).toEqual({
      decode_count: 2,
      decode_total_ms: 20,
      decode_last_ms: 8,
      decode_max_ms: 12,
      decode_average_ms: 10,
      retained_frames: 1,
      retained_blob_bytes: 450,
      retained_frames_high_water: 1,
      retained_blob_bytes_high_water: 450,
    });
  });

  it("releases live ownership while retaining scalar high-water marks", () => {
    adoptBrowserFrame(0, 128, 3);
    adoptBrowserFrame(0, 256, 4);
    releaseBrowserFrame(128);
    releaseBrowserFrame(256);
    releaseBrowserFrame(256); // late/double cleanup remains saturating

    expect(browserFrameMetrics()).toMatchObject({
      retained_frames: 0,
      retained_blob_bytes: 0,
      retained_frames_high_water: 2,
      retained_blob_bytes_high_water: 384,
    });
  });
});

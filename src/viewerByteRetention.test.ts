import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelInactiveViewerBytes,
  resetViewerByteRetentionForTest,
  scheduleInactiveViewerBytes,
  shedInactiveViewerBytes,
  viewerByteRetentionMetrics,
} from "./viewerByteRetention";

describe("inactive viewer byte retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetViewerByteRetentionForTest();
  });
  afterEach(() => {
    resetViewerByteRetentionForTest();
    vi.useRealTimers();
  });

  it("releases bytes after inactivity and records only scalar totals", () => {
    const release = vi.fn();
    scheduleInactiveViewerBytes("one", 12_345, release, 50);
    vi.advanceTimersByTime(49);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledOnce();
    expect(viewerByteRetentionMetrics()).toMatchObject({
      pendingViewers: 0,
      pendingBytes: 0,
      released: 1,
      releasedBytes: 12_345,
    });
  });

  it("cancels on activation and pressure accelerates remaining viewers", () => {
    const cancelled = vi.fn();
    scheduleInactiveViewerBytes("cancelled", 10, cancelled);
    expect(cancelInactiveViewerBytes("cancelled")).toBe(true);

    const release = vi.fn();
    scheduleInactiveViewerBytes("shed", 20, release);
    expect(shedInactiveViewerBytes()).toEqual({ viewers: 1, bytes: 20 });
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps one candidate per owner across reschedules", () => {
    const stale = vi.fn();
    const current = vi.fn();
    scheduleInactiveViewerBytes("same", 10, stale);
    scheduleInactiveViewerBytes("same", 30, current);
    expect(viewerByteRetentionMetrics()).toMatchObject({
      pendingViewers: 1,
      pendingBytes: 30,
    });
    shedInactiveViewerBytes();
    vi.runAllTimers();
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });
});

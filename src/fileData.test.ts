// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { base64ReadAdmissionBytes, readFileBase64 } from "./fileData";
import { IoBudget } from "./ioBudget";

const budget = () =>
  new IoBudget({
    maxConcurrent: 1,
    maxConcurrentPerScope: 1,
    maxActiveBytes: 2048,
    maxActiveBytesPerScope: 2048,
    maxQueued: 2,
    maxQueuedBytes: 2048,
  });

describe("readFileBase64", () => {
  it("rejects an oversized file before constructing a reader", async () => {
    const reader = vi.spyOn(globalThis, "FileReader");
    await expect(
      readFileBase64(new File(["large"], "large.png"), {
        scope: "p1",
        maxBytes: 4,
        budget: budget(),
      }),
    ).rejects.toThrow("exceeds the 0 MB attachment limit");
    expect(reader).not.toHaveBeenCalled();
    reader.mockRestore();
  });

  it("returns only the base64 payload", async () => {
    await expect(
      readFileBase64(new File(["hello"], "note.txt", { type: "text/plain" }), {
        scope: "p1",
        maxBytes: 16,
        budget: budget(),
      }),
    ).resolves.toBe("aGVsbG8=");
  });

  it("charges the retained File plus its base64 representation", async () => {
    const file = new File(["hello"], "note.txt");
    expect(base64ReadAdmissionBytes(file.size)).toBe(file.size + 8 + 1024);
    const belowPeak = base64ReadAdmissionBytes(file.size) - 1;
    const admission = new IoBudget({
      maxConcurrent: 1,
      maxConcurrentPerScope: 1,
      maxActiveBytes: belowPeak,
      maxActiveBytesPerScope: belowPeak,
      maxQueued: 1,
      maxQueuedBytes: belowPeak,
    });
    await expect(
      readFileBase64(file, {
        scope: "p1",
        maxBytes: 16,
        budget: admission,
      }),
    ).rejects.toMatchObject({ reason: "request-too-large" });
  });

  it("cancels while queued without starting a FileReader", async () => {
    const admission = budget();
    let release!: () => void;
    const blocker = admission.run(
      { scope: "p1", bytes: 1 },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const reader = vi.spyOn(globalThis, "FileReader");
    const controller = new AbortController();
    const pending = readFileBase64(new File(["hello"], "note.txt"), {
      scope: "p1",
      maxBytes: 16,
      signal: controller.signal,
      budget: admission,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reader).not.toHaveBeenCalled();
    release();
    await blocker;
    reader.mockRestore();
  });
});

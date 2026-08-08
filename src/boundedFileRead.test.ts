import { describe, expect, it, vi } from "vitest";
import { FileReadLimitError, readBoundedFile } from "./boundedFileRead";
import { IoBudget } from "./ioBudget";

const budget = () =>
  new IoBudget({
    maxConcurrent: 1,
    maxConcurrentPerScope: 1,
    maxActiveBytes: 16,
    maxActiveBytesPerScope: 16,
    maxQueued: 2,
    maxQueuedBytes: 16,
  });

describe("readBoundedFile", () => {
  it("refuses an oversized stat before reading", async () => {
    const read = vi.fn(async () => new Uint8Array());
    await expect(
      readBoundedFile("/repo/large.ts", {
        scope: "p1",
        maxBytes: 8,
        budget: budget(),
        reader: { stat: async () => ({ is_dir: false, size: 9 }), read },
      }),
    ).rejects.toBeInstanceOf(FileReadLimitError);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects growth after stat rather than retaining it", async () => {
    await expect(
      readBoundedFile("/repo/growing.ts", {
        scope: "p1",
        maxBytes: 8,
        budget: budget(),
        reader: {
          stat: async () => ({ is_dir: false, size: 4 }),
          read: async () => new Uint8Array(9),
        },
      }),
    ).rejects.toMatchObject({ bytes: 9, limit: 8 });
  });

  it("returns a file admitted by size", async () => {
    await expect(
      readBoundedFile("/repo/file.ts", {
        scope: "p1",
        maxBytes: 8,
        budget: budget(),
        reader: {
          stat: async () => ({ is_dir: false, size: 4 }),
          read: async () => new Uint8Array([1, 2, 3, 4]),
        },
      }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

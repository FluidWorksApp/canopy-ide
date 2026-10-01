import { describe, expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import * as ipc from "./ipc";

describe("filesystem metadata admission", () => {
  it("shares one in-flight stat for an identical path", async () => {
    let release!: (value: { is_dir: boolean; size: number; modified_ms: null }) => void;
    const stat = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ is_dir: boolean; size: number; modified_ms: null }>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ is_dir: false, size: 4, modified_ms: null });
    mockCommands({ fs_stat: stat });
    const first = ipc.fsStat("/repo/a.ts");
    const second = ipc.fsStat("/repo/a.ts");
    expect(first).toBe(second);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(1));
    release({ is_dir: false, size: 4, modified_ms: null });
    await first;
    await ipc.fsStat("/repo/a.ts");
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight directory enumeration and releases failures", async () => {
    let reject!: (error: Error) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ipc.DirEntry[]>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValueOnce([]);
    mockCommands({ fs_read_dir: read });
    const first = ipc.fsReadDir("/repo");
    const second = ipc.fsReadDir("/repo");
    expect(first).toBe(second);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    reject(new Error("gone"));
    await expect(first).rejects.toThrow("gone");
    await ipc.fsReadDir("/repo");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("deduplicates an equivalent metadata batch and exposes scalar counts", async () => {
    const statMany = vi.fn(async () => [
      { path: "/repo/a", is_dir: false, size: 2, modified_ms: null },
    ]);
    mockCommands({ fs_stat_many: statMany });

    const first = ipc.fsStatMany(["/repo/a", "/repo/b"]);
    const second = ipc.fsStatMany(["/repo/b", "/repo/a"]);
    expect(first).toBe(second);
    expect(ipc.fsMetadataIoSnapshot().statFlights).toBeGreaterThanOrEqual(1);
    await expect(first).resolves.toHaveLength(1);
    expect(statMany).toHaveBeenCalledTimes(1);
    expect(ipc.fsMetadataIoSnapshot().statFlights).toBe(0);
  });
});

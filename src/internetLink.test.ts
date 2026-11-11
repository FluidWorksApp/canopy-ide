import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  remoteStatus: vi.fn(),
  remoteEnable: vi.fn(),
  tunnelStatus: vi.fn(),
  tunnelStart: vi.fn(),
}));
vi.mock("./ipc", () => ipc);
import { ensureInternetLink } from "./internetLink";

const starting = { running: true, provider: "canopy", url: null, message: "Starting…" };
const up = { running: true, provider: "canopy", url: "https://x.example.com/abc", message: null };

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockReset());
  ipc.remoteStatus.mockResolvedValue({ enabled: true, port: 1 });
});

describe("ensureInternetLink", () => {
  it("waits for a tunnel that is still starting instead of failing with 'Starting…'", async () => {
    ipc.tunnelStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(starting).mockResolvedValue(up);
    ipc.tunnelStart.mockResolvedValue(starting);
    expect(await ensureInternetLink({ pollMs: 1 })).toBe("https://x.example.com");
  });

  it("reuses a tunnel that is already up", async () => {
    ipc.tunnelStatus.mockResolvedValue(up);
    expect(await ensureInternetLink()).toBe("https://x.example.com");
    expect(ipc.tunnelStart).not.toHaveBeenCalled();
  });

  it("reports the real reason when it fails", async () => {
    ipc.tunnelStatus.mockResolvedValue(null);
    ipc.tunnelStart.mockResolvedValue({ running: false, provider: "canopy", url: null, message: "Signed out" });
    await expect(ensureInternetLink({ pollMs: 1 })).rejects.toThrow("Signed out");
  });

  it("gives up with a readable message if it never comes up", async () => {
    ipc.tunnelStatus.mockResolvedValue(starting);
    ipc.tunnelStart.mockResolvedValue(starting);
    await expect(ensureInternetLink({ timeoutMs: 5, pollMs: 1 })).rejects.toThrow(/didn't come up/);
  });
});

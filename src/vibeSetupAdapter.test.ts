import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_VIBE_SETUP_VERIFICATION_DEPS } from "./vibeSetupVerification";
import * as ipc from "./ipc";

vi.mock("./ipc", () => ({
  onPtyExit: vi.fn(async () => () => {}),
  ptySpawnArgv: vi.fn(async () => ({ id: 1 })),
  ptyStats: vi.fn(async () => [{ id: 1, ports: [3000], output_bytes: 100, quiet_ms: 0 }]),
  ptyOutput: vi.fn(async () => "Server listening on port 3000"),
  ptyKill: vi.fn(async () => {}), ptyWrite: vi.fn(async () => {}),
  probeHttpReadiness: vi.fn(async () => true),
}));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("probes the declared HTTP path and retains the server until the graph releases it", async () => {
  const result = await DEFAULT_VIBE_SETUP_VERIFICATION_DEPS.proveReadiness({
    component: { id: "web", label: "Web", path: "/test" },
    command: { id: "serve", name: "Serve", command: "node server.js", purpose: "serve", readiness: { kind: "http", path: "/health" } },
    argv: ["node", "server.js"],
  });
  expect(result.ok).toBe(true);
  expect(ipc.probeHttpReadiness).toHaveBeenCalledWith(3000, "/health");
  expect(ipc.ptyKill).not.toHaveBeenCalled();
  if (result.ok) await result.release?.();
  expect(ipc.ptyKill).toHaveBeenCalledWith(1);
});

it("answers a supported install prompt once then reports a stuck prompt", async () => {
  vi.useFakeTimers();
  vi.mocked(ipc.ptyOutput).mockResolvedValueOnce("Need to install the following packages:\nfoo\nOk to proceed? (y)")
    .mockResolvedValue("Need to install the following packages:\nfoo\nOk to proceed? (y)");
  const result = DEFAULT_VIBE_SETUP_VERIFICATION_DEPS.proveReadiness({
    component: { id: "web", label: "Web", path: "/test" },
    command: { id: "install", name: "Install", command: "npx foo", purpose: "setup", readiness: { kind: "one-shot", timeoutMs: 60_000 } },
    argv: ["npx", "foo"],
  });
  await vi.advanceTimersByTimeAsync(11_000);
  expect((await result).ok).toBe(false);
  expect(ipc.ptyWrite).toHaveBeenCalledTimes(1);
  expect(ipc.ptyKill).toHaveBeenCalledWith(1);
});

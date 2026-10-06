import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exit: undefined as ((id: number) => void) | undefined,
  fsStat: vi.fn(),
  lspStart: vi.fn(),
  lspStop: vi.fn(),
  sendRequest: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../ipc", () => ({
  fsStat: mocks.fsStat,
  lspSend: vi.fn(),
  lspStart: mocks.lspStart,
  lspStop: mocks.lspStop,
  onLspExit: vi.fn(async (cb: (id: number) => void) => {
    mocks.exit = cb;
    return () => {};
  }),
}));

vi.mock("../monaco-setup", () => ({
  monaco: {
    Uri: {
      file: (path: string) => ({ path, toString: () => `file://${path}` }),
    },
  },
}));

vi.mock("monaco-languageclient", () => ({
  MonacoLanguageClient: class {
    start = mocks.start;
    sendRequest = mocks.sendRequest;
    stop = vi.fn(async () => {});
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

const root = "/repo";
const file = `${root}/src/a.ts`;
const launcher = `${root}/node_modules/typescript/bin/tsc`;

async function loadClient() {
  return import("./client");
}

describe("language server startup", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    mocks.exit = undefined;
    mocks.fsStat.mockReset().mockImplementation(async (path: string) => {
      if (path === launcher) return { isFile: true };
      throw new Error("missing");
    });
    mocks.lspStart.mockReset().mockResolvedValue(7);
    mocks.lspStop.mockReset().mockResolvedValue(undefined);
    mocks.sendRequest.mockReset().mockResolvedValue([]);
    mocks.start.mockReset().mockResolvedValue(undefined);
  });

  it("makes concurrent callers await one completed startup", async () => {
    let finish!: () => void;
    mocks.start.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const client = await loadClient();

    const first = client.ensureLanguageServer(file, root);
    const second = client.ensureLanguageServer(file, root);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());

    expect(mocks.lspStart).toHaveBeenCalledOnce();
    expect(await client.hasServerFor(file, root)).toBe(false);
    finish();
    await Promise.all([first, second]);
    expect(await client.hasServerFor(file, root)).toBe(true);
  });

  it("records a concrete initialization failure instead of staying unready", async () => {
    mocks.start.mockRejectedValue(new Error("Could not find a valid TypeScript installation"));
    const client = await loadClient();

    await client.ensureLanguageServer(file, root);

    expect(await client.hasServerFor(file, root)).toBe(false);
    expect(await client.describeMissingServer(file, root)).toContain(
      "Could not find a valid TypeScript installation",
    );
    expect(await client.describeMissingServer(file, root)).not.toContain("isn't ready yet");
    expect(mocks.lspStop).toHaveBeenCalledWith(7);
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("retries a transient initialization failure before answering", async () => {
    vi.useFakeTimers();
    mocks.lspStart.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    mocks.start.mockRejectedValueOnce(new Error("transport closed")).mockResolvedValueOnce(undefined);
    const client = await loadClient();

    const ready = client.ensureLanguageServer(file, root);
    await vi.advanceTimersByTimeAsync(500);
    await ready;

    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.lspStop).toHaveBeenCalledWith(7);
    expect(await client.hasServerFor(file, root)).toBe(true);
  });

  it("waits through the bounded restart plan instead of returning a retry notice", async () => {
    vi.useFakeTimers();
    mocks.lspStart
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9);
    mocks.start
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockRejectedValueOnce(new Error("transport closed again"))
      .mockResolvedValueOnce(undefined);
    const client = await loadClient();

    let answered = false;
    const ready = client.ensureLanguageServer(file, root).then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1_501);
    await ready;

    expect(mocks.start).toHaveBeenCalledTimes(3);
    expect(await client.hasServerFor(file, root)).toBe(true);
  });

  it("preserves a precise initialize error when the client reports Unknown reason", async () => {
    mocks.lspStart.mockImplementationOnce(async (
      _command: string,
      _args: string[],
      _root: string,
      onMessage: (message: string) => void,
    ) => {
      onMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message: "Could not find a valid TypeScript installation in this workspace",
        },
      }));
      return 7;
    });
    mocks.start.mockRejectedValueOnce(new Error("Unknown reason"));
    const client = await loadClient();

    await client.ensureLanguageServer(file, root);

    expect(await client.describeMissingServer(file, root)).toContain(
      "Could not find a valid TypeScript installation in this workspace",
    );
    expect(await client.describeMissingServer(file, root)).not.toContain("Unknown reason");
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("automatically restarts a desired server when its subprocess exits", async () => {
    vi.useFakeTimers();
    mocks.lspStart.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    const client = await loadClient();
    await client.ensureLanguageServer(file, root);
    expect(await client.hasServerFor(file, root)).toBe(true);

    mocks.exit?.(7);

    expect(await client.hasServerFor(file, root)).toBe(false);
    expect(await client.describeMissingServer(file, root)).toContain("exited unexpectedly");
    expect(await client.describeMissingServer(file, root)).toContain("restarting it (attempt 1/3)");

    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.lspStart).toHaveBeenCalledTimes(2);
    expect(await client.hasServerFor(file, root)).toBe(true);
  });

  it("cancels supervised restarts when the workspace closes", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    await client.ensureLanguageServer(file, root);
    mocks.exit?.(7);

    await client.stopWorkspaceServers(root);
    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.lspStart).toHaveBeenCalledOnce();
    expect(await client.hasServerFor(file, root)).toBe(false);
  });
});

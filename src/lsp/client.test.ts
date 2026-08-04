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
    mocks.start.mockRejectedValue(new Error("initialize rejected"));
    const client = await loadClient();

    await client.ensureLanguageServer(file, root);

    expect(await client.hasServerFor(file, root)).toBe(false);
    expect(await client.describeMissingServer(file, root)).toContain("initialize rejected");
    expect(await client.describeMissingServer(file, root)).not.toContain("isn't ready yet");
    expect(mocks.lspStop).toHaveBeenCalledWith(7);
  });

  it("removes a ready server when its subprocess exits", async () => {
    const client = await loadClient();
    await client.ensureLanguageServer(file, root);
    expect(await client.hasServerFor(file, root)).toBe(true);

    mocks.exit?.(7);

    expect(await client.hasServerFor(file, root)).toBe(false);
    expect(await client.describeMissingServer(file, root)).toContain("exited unexpectedly");
  });
});

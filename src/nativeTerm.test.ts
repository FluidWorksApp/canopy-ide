import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  remote: false,
  workspace: false,
}));
vi.mock("./host", () => ({
  invoke: mocks.invoke,
  isRemoteHost: () => mocks.remote,
  isWorkspaceHost: () => mocks.workspace,
}));

import { nativeTermAvailable, openNativeTerminal } from "./nativeTerm";

describe("nativeTerm", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.remote = false;
    mocks.workspace = false;
  });

  it("is available when the desktop app says the binary is bundled", async () => {
    mocks.invoke.mockResolvedValue(true);
    expect(await nativeTermAvailable()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("native_term_available");
  });

  it("is hidden when the build has no binary", async () => {
    mocks.invoke.mockResolvedValue(false);
    expect(await nativeTermAvailable()).toBe(false);
  });

  it("is hidden when the command fails", async () => {
    mocks.invoke.mockRejectedValue(new Error("unknown command"));
    expect(await nativeTermAvailable()).toBe(false);
  });

  it("is hidden on a remote or workspace host without asking", async () => {
    mocks.remote = true;
    expect(await nativeTermAvailable()).toBe(false);
    mocks.remote = false;
    mocks.workspace = true;
    expect(await nativeTermAvailable()).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("opens a window in the given folder", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await openNativeTerminal("/work/proj");
    expect(mocks.invoke).toHaveBeenCalledWith("native_term_open", { cwd: "/work/proj" });
  });
});

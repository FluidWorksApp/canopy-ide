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

import { act, renderHook } from "@testing-library/react";
import {
  forgetHandedOver,
  handedState,
  handOverToNative,
  handoverMenuItem,
  HANDOVER_POLL_MS,
  nativeHandoverStatus,
  nativeTermAvailable,
  NO_HANDOVER,
  openNativeTerminal,
  resetHandoverStatusForTest,
  takeBackFromNative,
  useHandoverStatus,
  type HandoverStatus,
} from "./nativeTerm";

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

describe("handing a terminal to a native window", () => {
  const status = (over: Partial<HandoverStatus> = {}): HandoverStatus => ({
    candidates: [4, 5],
    handed: [],
    ...over,
  });
  const item = (over: Partial<Parameters<typeof handoverMenuItem>[0]> = {}) =>
    handoverMenuItem({
      available: true,
      status: status(),
      ptyId: 4,
      onOpen: () => {},
      ...over,
    });

  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.remote = false;
    mocks.workspace = false;
    resetHandoverStatusForTest();
  });

  it("offers Open in Native Window for a hosted terminal, and runs the hand-over on click", () => {
    const onOpen = vi.fn();
    const entry = item({ onOpen });
    expect(entry?.label).toBe("Open in Native Window");
    expect(entry?.disabled).toBeFalsy();
    entry?.onClick?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("hides the entry, rather than disabling it, wherever it cannot work", () => {
    // Not hosted: persistent terminals are off, or this terminal's child is in
    // the app, so the host reports no candidates.
    expect(item({ status: status({ candidates: [] }) })).toBeNull();
    // Another terminal is hosted, this one is not.
    expect(item({ ptyId: 9 })).toBeNull();
    // A build with no native terminal (dev builds, Windows, a workspace).
    expect(item({ available: false })).toBeNull();
    // A tab with no session yet.
    expect(item({ ptyId: null })).toBeNull();
    expect(item({ ptyId: undefined })).toBeNull();
    // Already in a window: the tab offers Take back instead.
    expect(item({ status: status({ handed: [{ pty_id: 4, state: "in_window" }] }) })).toBeNull();
  });

  it("says where a handed-over terminal is", () => {
    const held = status({
      handed: [
        { pty_id: 4, state: "in_window" },
        { pty_id: 5, state: "detached" },
      ],
    });
    expect(handedState(held, 4)).toBe("in_window");
    expect(handedState(held, 5)).toBe("detached");
    expect(handedState(held, 6)).toBeNull();
    expect(handedState(held, null)).toBeNull();
  });

  it("calls the three commands with the terminal's id", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await handOverToNative(7);
    await takeBackFromNative(7);
    await forgetHandedOver(7);
    expect(mocks.invoke.mock.calls).toEqual([
      ["native_term_hand_over", { ptyId: 7 }],
      ["native_term_take_back", { ptyId: 7 }],
      ["native_term_forget", { ptyId: 7 }],
    ]);
  });

  it("reads the status from the desktop, and nothing where there is no native terminal", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "native_term_available"
        ? true
        : { candidates: [4], handed: [{ pty_id: 5, state: "ended" }] },
    );
    expect(await nativeHandoverStatus()).toEqual({
      candidates: [4],
      handed: [{ pty_id: 5, state: "ended" }],
    });
    resetHandoverStatusForTest();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(false);
    expect(await nativeHandoverStatus()).toEqual(NO_HANDOVER);
    expect(mocks.invoke).not.toHaveBeenCalledWith("native_term_handover_status");
    // An answer that is not the shape is nothing, not a crash.
    resetHandoverStatusForTest();
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "native_term_available" ? true : { nonsense: 1 },
    );
    expect(await nativeHandoverStatus()).toEqual(NO_HANDOVER);
  });

  it("polls while something shows it and stops when nothing does", async () => {
    vi.useFakeTimers();
    try {
      let answer: HandoverStatus = status();
      mocks.invoke.mockImplementation(async (command: string) =>
        command === "native_term_available" ? true : answer,
      );
      const { result, unmount } = renderHook(() => useHandoverStatus());
      expect(result.current).toEqual(NO_HANDOVER);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(result.current.candidates).toEqual([4, 5]);
      // The window opens: the next poll shows the terminal handed over.
      answer = status({ handed: [{ pty_id: 4, state: "in_window" }] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS);
      });
      expect(handedState(result.current, 4)).toBe("in_window");
      // The window closes: the terminal is still there, detached.
      answer = status({ handed: [{ pty_id: 4, state: "detached" }] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS);
      });
      expect(handedState(result.current, 4)).toBe("detached");
      unmount();
      const calls = mocks.invoke.mock.calls.length;
      await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS * 3);
      expect(mocks.invoke.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ipcTypes from "./ipc";

const clipboardWatchSet = vi.fn((o: ipcTypes.ClipboardWatchOptions) => {
  void o;
  return Promise.resolve();
});
const clipboardRecent = vi.fn(() => Promise.resolve([] as ipcTypes.Clip[]));
let onChanged: (() => void) | null = null;

vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  clipboardWatchSet: (o: ipcTypes.ClipboardWatchOptions) => clipboardWatchSet(o),
  clipboardRecent: () => clipboardRecent(),
  onClipboardChanged: (cb: () => void) => {
    onChanged = cb;
    return Promise.resolve(() => {});
  },
  onClipboardBlocked: () => Promise.resolve(() => {}),
}));

import * as store from "./clipboardStore";
import { updateSettings } from "./settings";

const clip = (id: number, preview: string): ipcTypes.Clip => ({
  id,
  ts: Math.floor(Date.now() / 1000),
  preview,
  chars: preview.length,
  lines: 1,
  project: "p1",
});

beforeEach(() => {
  store.__reset();
  clipboardWatchSet.mockClear();
  clipboardRecent.mockClear();
  clipboardRecent.mockResolvedValue([]);
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("clipboardStore", () => {
  it("declares the settings once and never re-declares an unchanged set", async () => {
    updateSettings({ clipboardHistory: true, clipboardKeep: 50 });
    store.sync("p1");
    store.sync("p1");
    store.sync("p1");
    await Promise.resolve();
    expect(clipboardWatchSet).toHaveBeenCalledTimes(1);
    expect(clipboardWatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, keep: 50, project: "p1" }),
    );
  });

  it("re-declares when the project changes, so clips are tagged with it", async () => {
    updateSettings({ clipboardHistory: true });
    store.sync("p1");
    store.sync("p2");
    await Promise.resolve();
    expect(clipboardWatchSet).toHaveBeenCalledTimes(2);
    expect(clipboardWatchSet).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: "p2" }),
    );
  });

  it("declares 'off' without ever asking for the list", async () => {
    store.sync("p1");
    await Promise.resolve();
    expect(clipboardWatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    // The whole point of default-off: nothing is read, so no store is opened
    // and no pasteboard alert can be raised.
    expect(clipboardRecent).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("reloads when Rust says a clip was captured, and tells subscribers", async () => {
    updateSettings({ clipboardHistory: true });
    const seen = vi.fn();
    store.subscribe(seen);
    store.sync("p1");
    await Promise.resolve();

    clipboardRecent.mockResolvedValue([clip(1, "hello")]);
    onChanged?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toHaveLength(1);
    expect(seen).toHaveBeenCalled();
  });

  it("empties the list when the feature is switched off", async () => {
    updateSettings({ clipboardHistory: true });
    clipboardRecent.mockResolvedValue([clip(1, "hello")]);
    store.sync("p1");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toHaveLength(1);

    updateSettings({ clipboardHistory: false });
    store.sync("p1");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("survives a store that cannot be opened", async () => {
    updateSettings({ clipboardHistory: true });
    clipboardRecent.mockRejectedValue(new Error("newer schema"));
    store.sync("p1");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual([]);
  });
});

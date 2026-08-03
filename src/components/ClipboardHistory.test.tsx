import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Clip } from "../ipc";
import { resolve } from "../shortcuts";
import { getSettings, updateSettings } from "../settings";

const readClip = vi.fn<(id: number) => Promise<string>>();
let rows: Clip[] = [];

vi.mock("../ipc", async (orig) => ({
  ...(await orig<typeof import("../ipc")>()),
  clipboardRead: (id: number) => readClip(id),
}));

vi.mock("../clipboardStore", () => ({
  getSnapshot: () => rows,
  subscribe: () => () => {},
}));

import { ClipboardHistory } from "./ClipboardHistory";

const chordEvent = () => {
  const chord = resolve("clipboard-history")!;
  return {
    code: chord.code!,
    key: "v",
    metaKey: chord.meta,
    ctrlKey: chord.ctrl,
    altKey: chord.alt,
    shiftKey: chord.shift,
  };
};

const clip = (id: number): Clip => ({
  id,
  ts: Math.floor(Date.now() / 1000) - id,
  preview: `clip ${id}`,
  chars: 6,
  lines: 1,
  project: "p1",
});

beforeEach(() => {
  localStorage.clear();
  rows = Array.from({ length: 12 }, (_, i) => clip(i + 1));
  readClip.mockReset();
  readClip.mockImplementation(async (id) => `whole clip ${id}`);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("ClipboardHistory", () => {
  it("shows no tray icon while history is off", () => {
    render(<ClipboardHistory visible />);
    expect(
      screen.queryByRole("button", { name: /Clipboard history/ }),
    ).toBeNull();
  });

  it("keeps capture opt-in and enables it only from the explicit action", () => {
    render(<ClipboardHistory visible />);
    fireEvent.keyDown(window, chordEvent());

    expect(screen.getByText(/History is off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enable history" }));
    expect(getSettings().clipboardHistory).toBe(true);
    expect(
      screen.getByRole("button", { name: /Clipboard history/ }),
    ).toBeTruthy();
  });

  it("shows only the latest ten clips in the clickable list", () => {
    updateSettings({ clipboardHistory: true });
    render(<ClipboardHistory visible />);
    fireEvent.click(screen.getByRole("button", { name: /Clipboard history/ }));

    expect(screen.getAllByRole("option")).toHaveLength(10);
    expect(screen.getByText("clip 1")).toBeTruthy();
    expect(screen.queryByText("clip 11")).toBeNull();
  });

  it("shows cycling and pastes the highlighted clip when modifiers are released", async () => {
    updateSettings({ clipboardHistory: true });
    render(<ClipboardHistory visible />);
    const down = chordEvent();

    fireEvent.keyDown(window, down);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(window, down);
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyUp(window, { code: "ShiftLeft", key: "Shift" });

    await waitFor(() => expect(readClip).toHaveBeenCalledWith(2));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("whole clip 2");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

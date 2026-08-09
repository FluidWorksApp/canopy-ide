// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { updateSettings } from "../settings";
import { Dictation } from "./Dictation";

const seams = vi.hoisted(() => ({
  start: vi.fn<() => Promise<string>>(),
}));

vi.mock("../ipc", () => ({
  dictationSupported: () => Promise.resolve(true),
  dictationStart: () => seams.start(),
  dictationStop: () => Promise.resolve(""),
  dictationCancel: () => Promise.resolve(),
  onDictationProgress: () => Promise.resolve(() => {}),
  onDictationLevel: () => Promise.resolve(() => {}),
  onDictationPartial: () => Promise.resolve(() => {}),
}));

describe("Dictation engine startup failure", () => {
  beforeEach(() => {
    localStorage.clear();
    seams.start.mockReset();
    updateSettings({
      dictationTriggerMode: "combo",
      dictationHotkey: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        code: "KeyD",
      },
    });
  });

  it("notifies in plain language and lets the user retry", async () => {
    const message =
      "Dictation can't load its speech model — the speech runtime wasn't found. Restart Canopy and try again.";
    seams.start.mockRejectedValue(new Error(message));
    const notify = vi.fn();
    render(<Dictation notify={notify} />);

    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    await waitFor(() => expect(seams.start).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent(message);
    expect(notify).toHaveBeenCalledWith(`Error: ${message}`, "error", {
      dedupe: "dictation:engine-load",
    });

    fireEvent.keyDown(window, { key: "d", code: "KeyD" });
    await waitFor(() => expect(seams.start).toHaveBeenCalledTimes(2));
  });
});

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  screencap: vi.fn(),
  tap: vi.fn(),
}));
vi.mock("../ipc", () => ({ androidScreencap: h.screencap, androidTap: h.tap }));
vi.mock("../host", () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(event, cb);
    return Promise.resolve(() => h.handlers.delete(event));
  },
}));
import FloatingPhone from "./FloatingPhone";
import { nearestCorner } from "../devices/corner";

beforeEach(() => {
  vi.useFakeTimers();
  h.handlers.clear();
  h.screencap.mockResolvedValue(new ArrayBuffer(8));
  globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe("FloatingPhone", () => {
  it("snaps to the nearest corner", () => {
    expect(nearestCorner(10, 10, 1000, 800)).toBe("tl");
    expect(nearestCorner(900, 700, 1000, 800)).toBe("br");
    expect(nearestCorner(900, 100, 1000, 800)).toBe("tr");
    expect(nearestCorner(100, 700, 1000, 800)).toBe("bl");
  });

  it("shows Agent driving after an agent acts on this phone, then clears", async () => {
    render(
      <FloatingPhone
        serial="abc"
        projectDir="/p"
        label="Mi 11X"
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByText("Agent driving")).toBeNull();
    act(() =>
      h.handlers.get("device:agent-op")!({
        payload: { serial: "abc", op: "tap" },
      }),
    );
    expect(screen.getByText("Agent driving")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(screen.queryByText("Agent driving")).toBeNull();
  });

  it("ignores an agent acting on a different phone", async () => {
    render(<FloatingPhone serial="abc" projectDir="/p" onClose={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    act(() =>
      h.handlers.get("device:agent-op")!({
        payload: { serial: "other", op: "tap" },
      }),
    );
    expect(screen.queryByText("Agent driving")).toBeNull();
  });
});

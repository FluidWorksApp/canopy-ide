import { describe, expect, it, vi } from "vitest";
import { INSERT_TEXT_EVENT, insertTextAtCursor } from "./insertText";

describe("insertTextAtCursor", () => {
  it("inserts into the field that held focus before a popup was clicked", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    });

    insertTextAtCursor("chosen clip", input);

    expect(document.activeElement).toBe(input);
    expect(exec).toHaveBeenCalledWith("insertText", false, "chosen clip");
    input.remove();
  });

  it("routes non-field insertion to the active terminal", () => {
    const seen = vi.fn();
    window.addEventListener(INSERT_TEXT_EVENT, seen, { once: true });

    insertTextAtCursor("terminal clip", document.body);

    expect((seen.mock.calls[0][0] as CustomEvent).detail).toBe("terminal clip");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import {
  OSC52_INPUT_WINDOW_MS,
  OSC52_MAX_BYTES,
  forceSelectionHint,
  osc52Copy,
  parseOsc52,
  readClipboardText,
  terminalMenuItems,
  writeClipboardText,
} from "./terminalClipboard";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("parseOsc52", () => {
  it("decodes a clipboard write, whatever selection it names", () => {
    expect(parseOsc52(`c;${b64("hello")}`)).toBe("hello");
    expect(parseOsc52(`;${b64("empty target")}`)).toBe("empty target");
    expect(parseOsc52(`pc;${b64("primary too")}`)).toBe("primary too");
  });

  it("decodes UTF-8, not Latin-1", () => {
    expect(parseOsc52(`c;${b64("héllo — 世界 🌲")}`)).toBe("héllo — 世界 🌲");
  });

  it("tolerates base64 wrapped across lines", () => {
    const wrapped = b64("a fairly long line of copied terminal output").replace(/(.{16})/g, "$1\n");
    expect(parseOsc52(`c;${wrapped}`)).toBe("a fairly long line of copied terminal output");
  });

  it("never answers a clipboard read request", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52(";?")).toBeNull();
  });

  it("ignores clears, malformed payloads and missing parameters", () => {
    expect(parseOsc52("c;")).toBeNull();
    expect(parseOsc52("c;not base64!")).toBeNull();
    expect(parseOsc52("c;A")).toBeNull();
    expect(parseOsc52(b64("no selection parameter"))).toBeNull();
  });

  it("refuses payloads over the cap before decoding them", () => {
    expect(parseOsc52(`c;${b64("x".repeat(100))}`, 99)).toBeNull();
    expect(parseOsc52(`c;${b64("x".repeat(99))}`, 99)).toBe("x".repeat(99));
    const huge = "A".repeat(Math.ceil(OSC52_MAX_BYTES / 3) * 4 + 4);
    expect(parseOsc52(`c;${huge}`)).toBeNull();
  });
});

describe("osc52Copy", () => {
  const data = `c;${b64("copied")}`;
  it("copies only shortly after the user's own input", () => {
    expect(osc52Copy(data, 5)).toBe("copied");
    expect(osc52Copy(data, OSC52_INPUT_WINDOW_MS)).toBe("copied");
    expect(osc52Copy(data, OSC52_INPUT_WINDOW_MS + 1)).toBeNull();
  });
  it("drops writes when there has been no input at all (replayed output)", () => {
    expect(osc52Copy(data, Number.POSITIVE_INFINITY)).toBeNull();
    expect(osc52Copy(data, Number.NaN)).toBeNull();
  });
});

describe("clipboard access", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const readText = vi.fn<() => Promise<string>>();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
  afterEach(() => {
    writeText.mockReset();
    readText.mockReset();
  });

  it("writes through the native clipboard, which needs no user gesture", async () => {
    const written: unknown[] = [];
    mockCommands({ clipboard_write_text: (args: Record<string, unknown>) => void written.push(args.text) });
    await expect(writeClipboardText("from the remote")).resolves.toBe(true);
    expect(written).toEqual(["from the remote"]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the webview clipboard where native is unsupported", async () => {
    mockCommands({
      clipboard_write_text: () => {
        throw new Error("unsupported");
      },
    });
    writeText.mockResolvedValue(undefined);
    await expect(writeClipboardText("fallback")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("fallback");
  });

  it("does nothing for empty text", async () => {
    mockCommands({});
    await expect(writeClipboardText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reads natively for a menu Paste, falling back to the webview", async () => {
    mockCommands({ clipboard_read_text: () => "native text" });
    await expect(readClipboardText()).resolves.toBe("native text");
    mockCommands({
      clipboard_read_text: () => {
        throw new Error("unsupported");
      },
    });
    readText.mockResolvedValue("webview text");
    await expect(readClipboardText()).resolves.toBe("webview text");
  });
});

describe("terminalMenuItems", () => {
  const actions = () => ({
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
  });
  const labels = (items: { label?: string; separator?: boolean }[]) =>
    items.map((i) => (i.separator ? "—" : i.label));

  it("enables Copy only with a selection", () => {
    const a = actions();
    const withSel = terminalMenuItems({ ...a, hasSelection: true, mouseTracking: false }, true);
    expect(labels(withSel)).toEqual(["Copy", "Paste", "—", "Select All", "Clear"]);
    expect(withSel[0].disabled).toBe(false);
    withSel[0].onClick?.();
    expect(a.copy).toHaveBeenCalled();
    const noSel = terminalMenuItems({ ...a, hasSelection: false, mouseTracking: false }, true);
    expect(noSel[0].disabled).toBe(true);
  });

  it("explains the modifier-drag when a TUI owns the mouse and nothing is selected", () => {
    const a = actions();
    const mac = terminalMenuItems({ ...a, hasSelection: false, mouseTracking: true }, true);
    expect(mac[1]).toEqual({ label: forceSelectionHint(true), disabled: true });
    expect(forceSelectionHint(true)).toContain("Option");
    expect(forceSelectionHint(false)).toContain("Shift");
    const selected = terminalMenuItems({ ...a, hasSelection: true, mouseTracking: true }, true);
    expect(labels(selected)).not.toContain(forceSelectionHint(true));
  });

  it("wires Paste, Select All and Clear", () => {
    const a = actions();
    const items = terminalMenuItems({ ...a, hasSelection: false, mouseTracking: false }, true);
    items.find((i) => i.label === "Paste")?.onClick?.();
    items.find((i) => i.label === "Select All")?.onClick?.();
    items.find((i) => i.label === "Clear")?.onClick?.();
    expect(a.paste).toHaveBeenCalled();
    expect(a.selectAll).toHaveBeenCalled();
    expect(a.clear).toHaveBeenCalled();
    expect(items.find((i) => i.label === "Paste")?.hint).toBe("⌘V");
  });
});

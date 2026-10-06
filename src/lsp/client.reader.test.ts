import { describe, expect, it, vi } from "vitest";
import { IpcMessageReader } from "./ipcMessageReader";

const limits = {
  maxFrameChars: 64,
  maxBufferedMessages: 2,
  maxBufferedBytes: 256,
};

describe("IpcMessageReader bounds", () => {
  it("bounds messages retained before the language client listens", () => {
    const reader = new IpcMessageReader(limits);
    const error = vi.fn();
    reader.onError(error);
    reader.push(JSON.stringify({ jsonrpc: "2.0", method: "a" }));
    reader.push(JSON.stringify({ jsonrpc: "2.0", method: "b" }));
    reader.push(JSON.stringify({ jsonrpc: "2.0", method: "c" }));

    expect(error).toHaveBeenCalledTimes(1);
    expect(reader.snapshot()).toEqual({
      bufferedMessages: 0,
      bufferedBytes: 0,
      failed: true,
    });
  });

  it("rejects an oversized frame before JSON.parse", () => {
    const reader = new IpcMessageReader(limits);
    const error = vi.fn();
    const observed = vi.fn();
    reader.onError(error);
    reader.push(`{"value":"${"x".repeat(80)}"}`, observed);

    expect(error).toHaveBeenCalledTimes(1);
    expect(observed).not.toHaveBeenCalled();
    expect(reader.snapshot().failed).toBe(true);
  });

  it("releases the startup buffer after attaching a listener", () => {
    const reader = new IpcMessageReader(limits);
    const received = vi.fn();
    reader.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    expect(reader.snapshot().bufferedMessages).toBe(1);

    reader.listen(received);

    expect(received).toHaveBeenCalledTimes(1);
    expect(reader.snapshot().bufferedMessages).toBe(0);
    expect(reader.snapshot().bufferedBytes).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { decodePtyChunk } from "./ipc";

const framed = (start: bigint, gap: boolean, text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(16 + body.length);
  out.set([0x43, 0x50, 0x54, 0x59, gap ? 1 : 0], 0);
  new DataView(out.buffer).setBigUint64(8, start, true);
  out.set(body, 16);
  return out;
};

describe("PTY cursor envelope", () => {
  it("decodes an absolute range without copying its body", () => {
    const payload = framed(41n, false, "hello");
    const chunk = decodePtyChunk(payload.buffer as ArrayBuffer);
    expect(chunk).toMatchObject({ start: 41, end: 46, gap: false });
    expect(new TextDecoder().decode(chunk.bytes)).toBe("hello");
    expect(chunk.bytes.buffer).toBe(payload.buffer);
  });

  it("surfaces replay truncation", () => {
    expect(decodePtyChunk([...framed(900n, true, "tail")])).toMatchObject({
      start: 900,
      end: 904,
      gap: true,
    });
  });
});

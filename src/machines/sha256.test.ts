import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Sha256 } from "./sha256";

const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Sha256", () => {
  it("matches the known digests", () => {
    expect(new Sha256().hex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("gives the same digest however the bytes are cut up", () => {
    const data = new Uint8Array(200_003);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 3)) & 0xff;
    const whole = reference(data);
    for (const step of [1, 7, 55, 56, 63, 64, 65, 119, 120, 4096, 65_537]) {
      const hash = new Sha256();
      for (let at = 0; at < data.length; at += step) hash.update(data.subarray(at, at + step));
      expect(hash.hex(), `step ${step}`).toBe(whole);
    }
  });

  it("pads correctly at every length around a block boundary", () => {
    for (let length = 0; length <= 130; length++) {
      const data = new Uint8Array(length).fill(0x61);
      expect(new Sha256().update(data).hex(), `length ${length}`).toBe(reference(data));
    }
  });

  it("refuses more input once the digest is taken", () => {
    const hash = new Sha256();
    hash.hex();
    expect(() => hash.update(new Uint8Array(1))).toThrow();
  });
});

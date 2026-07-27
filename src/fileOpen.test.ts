import { describe, it, expect } from "vitest";
import {
  blockForOpen,
  describeBlock,
  formatBytes,
  isBinaryExtension,
  looksBinary,
  sizeLimitFor,
} from "./fileOpen";

const MB = 1024 * 1024;

describe("blockForOpen", () => {
  it("refuses archives and binaries at any size", () => {
    expect(blockForOpen("/repo/dist.zip", "code", 12)).toMatchObject({ reason: "binary" });
    expect(blockForOpen("/repo/app.dmg", "code", 900 * MB)).toMatchObject({ reason: "binary" });
    expect(blockForOpen("/repo/model.safetensors", "code", 4 * MB)).toMatchObject({
      reason: "binary",
    });
    expect(blockForOpen("/repo/clip.mp4", "code", 1)).toMatchObject({ reason: "binary" });
  });

  it("still opens the binary formats that have viewers", () => {
    expect(blockForOpen("/repo/spec.pdf", "pdf", 20 * MB)).toBeNull();
    expect(blockForOpen("/repo/shot.png", "image", 20 * MB)).toBeNull();
    expect(blockForOpen("/repo/book.xlsx", "sheet", 20 * MB)).toBeNull();
    expect(blockForOpen("/repo/notes.docx", "docx", 20 * MB)).toBeNull();
  });

  it("caps by the viewer that would render it, not one number", () => {
    // A 40 MB PDF is fine; a 40 MB log is not.
    expect(blockForOpen("/repo/manual.pdf", "pdf", 40 * MB)).toBeNull();
    expect(blockForOpen("/repo/server.log", "code", 40 * MB)).toMatchObject({
      reason: "too-large",
      size: 40 * MB,
      limit: sizeLimitFor("code"),
    });
    expect(blockForOpen("/repo/server.log", "code", 4 * MB)).toBeNull();
  });

  it("lets ordinary source through", () => {
    expect(blockForOpen("/repo/src/main.rs", "code", 40_000)).toBeNull();
    expect(blockForOpen("/repo/README.md", "markdown", 4000)).toBeNull();
  });

  it("ignores case and directory names", () => {
    expect(isBinaryExtension("/repo/Build.ZIP")).toBe(true);
    expect(isBinaryExtension("/repo/zip/notes.txt")).toBe(false);
    expect(isBinaryExtension("/repo/Makefile")).toBe(false);
    expect(isBinaryExtension("/repo/.gitignore")).toBe(false);
  });
});

describe("looksBinary", () => {
  const bytes = (...v: number[]) => Uint8Array.from(v);

  it("catches a NUL byte in the head", () => {
    expect(looksBinary(bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x01))).toBe(true);
  });

  it("passes text, including UTF-8 and empty files", () => {
    expect(looksBinary(new TextEncoder().encode("const x = 1 // café ☕\n"))).toBe(false);
    expect(looksBinary(bytes())).toBe(false);
  });

  it("only sniffs the head, so a NUL past 8 KiB is not a veto", () => {
    const big = new Uint8Array(20_000).fill(0x61);
    big[9000] = 0;
    expect(looksBinary(big)).toBe(false);
  });
});

describe("messages", () => {
  it("sizes in readable units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(40 * MB)).toBe("40 MB");
    expect(formatBytes(3 * 1024 * MB)).toBe("3.0 GB");
  });

  it("explains each refusal in its own terms", () => {
    const binary = describeBlock({ reason: "binary", size: 4 * MB, limit: 8 * MB });
    expect(binary.title).toMatch(/binary/i);
    expect(binary.detail).toContain("4.0 MB");

    const large = describeBlock({ reason: "too-large", size: 40 * MB, limit: 8 * MB });
    expect(large.title).toMatch(/too large/i);
    expect(large.detail).toContain("40 MB");
    expect(large.detail).toContain("8.0 MB");
  });
});

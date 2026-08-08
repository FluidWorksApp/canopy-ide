import { describe, expect, it } from "vitest";
import { archiveBudgetError } from "./archiveBudget";

function zipDirectory(expandedSizes: number[]): Uint8Array {
  const centralBytes = expandedSizes.length * 46;
  const bytes = new Uint8Array(centralBytes + 22);
  const view = new DataView(bytes.buffer);
  expandedSizes.forEach((size, index) => {
    const at = index * 46;
    view.setUint32(at, 0x02014b50, true);
    view.setUint32(at + 24, size, true);
  });
  const eocd = centralBytes;
  view.setUint32(eocd, 0x06054b50, true);
  view.setUint16(eocd + 8, expandedSizes.length, true);
  view.setUint16(eocd + 10, expandedSizes.length, true);
  view.setUint32(eocd + 12, centralBytes, true);
  view.setUint32(eocd + 16, 0, true);
  return bytes;
}

describe("viewer archive preflight", () => {
  it("accepts a bounded central directory", () => {
    expect(
      archiveBudgetError(zipDirectory([4, 8]), {
        maxEntries: 2,
        maxExpandedBytes: 12,
        maxEntryBytes: 8,
      }),
    ).toBeNull();
  });

  it("rejects aggregate expansion before invoking a decoder", () => {
    expect(
      archiveBudgetError(zipDirectory([8, 8]), {
        maxEntries: 2,
        maxExpandedBytes: 12,
        maxEntryBytes: 8,
      }),
    ).toContain("expands past");
  });

  it("rejects entry count and individual expansion limits", () => {
    const zip = zipDirectory([20, 1]);
    expect(
      archiveBudgetError(zip, {
        maxEntries: 1,
        maxExpandedBytes: 100,
        maxEntryBytes: 100,
      }),
    ).toContain("2 entries");
    expect(
      archiveBudgetError(zip, {
        maxEntries: 2,
        maxExpandedBytes: 100,
        maxEntryBytes: 10,
      }),
    ).toContain("per-entry limit");
  });
});

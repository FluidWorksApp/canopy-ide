import { describe, expect, it } from "vitest";
import { dropUploadPercent, dropUploadReducer, type DropUploadState } from "./dropUpload";

const start = dropUploadReducer(null, { type: "start", id: "a", totalFiles: 2, name: "x.pdf" })!;

describe("dropUploadReducer", () => {
  it("shows an indeterminate state immediately on start", () => {
    expect(start.status).toBe("uploading");
    expect(dropUploadPercent(start)).toBeNull();
  });
  it("tracks progress for the active id and ignores stale ids", () => {
    const next = dropUploadReducer(start, { type: "progress", id: "a", name: "y.csv", bytes: 50, totalBytes: 200, files: 1, totalFiles: 2 })!;
    expect(dropUploadPercent(next)).toBe(25);
    expect(next.name).toBe("y.csv");
    expect(dropUploadReducer(next, { type: "progress", id: "b", name: "z", bytes: 1, totalBytes: 1, files: 0, totalFiles: 1 })).toBe(next);
  });
  it("clears on done and keeps a failure visible", () => {
    expect(dropUploadReducer(start, { type: "done", id: "a" })).toBeNull();
    expect(dropUploadReducer(start, { type: "done", id: "b" })).toBe(start);
    const failed = dropUploadReducer(start, { type: "fail", id: "a", error: "boom" }) as DropUploadState;
    expect(failed).toMatchObject({ status: "error", error: "boom" });
    expect(dropUploadReducer(failed, { type: "dismiss" })).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DropUploadProgress } from "./DropUploadProgress";
import type { DropUploadState } from "../dropUpload";

const base: DropUploadState = { id: "a", status: "uploading", name: "report.pdf", bytes: 0, totalBytes: 0, files: 0, totalFiles: 2 };
afterEach(cleanup);

describe("DropUploadProgress", () => {
  it("renders an indeterminate bar right away", () => {
    render(<DropUploadProgress state={base} onDismiss={() => {}} />);
    expect(screen.getByText("Uploading report.pdf (1 of 2)")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });
  it("shows the percent once bytes are known", () => {
    render(<DropUploadProgress state={{ ...base, bytes: 50, totalBytes: 200, files: 1 }} onDismiss={() => {}} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("Uploading report.pdf (2 of 2)")).toBeTruthy();
  });
  it("shows an error and dismisses it", () => {
    const onDismiss = vi.fn();
    render(<DropUploadProgress state={{ ...base, status: "error", error: "no space" }} onDismiss={onDismiss} />);
    expect(screen.getByRole("alert").textContent).toContain("Upload failed: no space");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

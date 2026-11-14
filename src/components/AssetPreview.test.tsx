import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetPreview } from "./AssetPreview";
import { mockCommands } from "../test/setup";

const anchor = { left: 600, top: 100, right: 700, bottom: 120, width: 100, height: 20, x: 600, y: 100 } as DOMRect;
const shot = {
  path: "/Users/me/.canopy/sessions/abc/scratchpad/shot.png",
  name: "shot.png",
  kind: "image" as const,
};

describe("AssetPreview outside every project", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(cleanup);

  it("falls back to the read-only preview when the project read refuses", async () => {
    const seen: string[] = [];
    mockCommands({
      fs_read_file: () => {
        seen.push("fs_read_file");
        throw new Error("path outside workspace scope: /x");
      },
      fs_read_preview: () => {
        seen.push("fs_read_preview");
        return new Uint8Array([1, 2, 3]).buffer;
      },
    });
    const { container } = render(<AssetPreview asset={shot} anchor={anchor} />);
    await waitFor(() => expect(container.ownerDocument.querySelector(".asset-preview img")).not.toBeNull());
    expect(seen).toEqual(["fs_read_file", "fs_read_preview"]);
  });

  it("does not use the fallback when the project read works", async () => {
    const seen: string[] = [];
    mockCommands({
      fs_read_file: () => {
        seen.push("fs_read_file");
        return new Uint8Array([1]).buffer;
      },
      fs_read_preview: () => {
        seen.push("fs_read_preview");
        return new Uint8Array([1]).buffer;
      },
    });
    render(<AssetPreview asset={shot} anchor={anchor} />);
    await waitFor(() => expect(document.querySelector(".asset-preview img")).not.toBeNull());
    expect(seen).toEqual(["fs_read_file"]);
  });

  it("says there is no preview, not that it is outside the project, when both refuse", async () => {
    mockCommands({
      fs_read_file: () => {
        throw new Error("outside");
      },
      fs_read_preview: () => {
        throw new Error("That location holds credentials or private data and is never opened from a link.");
      },
    });
    render(<AssetPreview asset={shot} anchor={anchor} />);
    expect(await screen.findByText("No preview for this file. Click to open.")).toBeInTheDocument();
  });
});

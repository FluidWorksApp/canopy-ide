import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResearchImportCta } from "./ResearchImportCta";
import { mockCommands } from "../test/setup";

const props = {
  projectId: "p1",
  projectName: "Canopy",
  roots: ["/repo"],
  path: "/repo/NOTES.md",
  onOpen: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ResearchImportCta", () => {
  it("offers to adopt a file that is not research yet", async () => {
    const imported = vi.fn(() => ({ id: "0004-notes", title: "Notes" }));
    mockCommands({
      research_for_file: () => null,
      research_import: imported,
      research_list: () => [],
    });
    const onOpen = vi.fn();
    render(<ResearchImportCta {...props} onOpen={onOpen} />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Import into research/ }),
    );
    await waitFor(() => expect(imported).toHaveBeenCalled());
    // Straight to what it made — an import that leaves you on the file you
    // were already looking at gives no sign it did anything.
    expect(onOpen).toHaveBeenCalledWith("0004-notes");
  });

  it("becomes the way back once the file is already an entry", async () => {
    mockCommands({ research_for_file: () => "0004-notes" });
    const onOpen = vi.fn();
    const imported = vi.fn();
    mockCommands({ research_for_file: () => "0004-notes", research_import: imported });
    render(<ResearchImportCta {...props} onOpen={onOpen} />);

    const back = await screen.findByRole("button", { name: /In research/ });
    await userEvent.click(back);
    expect(onOpen).toHaveBeenCalledWith("0004-notes");
    // And never offers to import it a second time.
    expect(screen.queryByText(/Import into research/)).toBeNull();
    expect(imported).not.toHaveBeenCalled();
  });

  it("renders nothing until it knows which of the two it is", async () => {
    // The lookup is a round trip. Guessing "Import" in the meantime would
    // flicker that label onto a file that is already imported.
    let settle: (v: string | null) => void = () => {};
    mockCommands({
      research_for_file: () => new Promise((r) => (settle = r)),
    });
    const { container } = render(<ResearchImportCta {...props} />);
    expect(container.querySelector("button")).toBeNull();
    settle(null);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Import into research/ }))
        .toBeInTheDocument(),
    );
  });

  it("keeps the file open and says why when the store refuses", async () => {
    mockCommands({
      research_for_file: () => null,
      research_import: () => {
        throw new Error("/repo/NOTES.md is empty — there is nothing to import yet.");
      },
    });
    const onNotice = vi.fn();
    const onOpen = vi.fn();
    render(<ResearchImportCta {...props} onOpen={onOpen} onNotice={onNotice} />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Import into research/ }),
    );
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(String(onNotice.mock.calls[0][0])).toContain("nothing to import");
    expect(onNotice.mock.calls[0][1]).toBe("error");
    // Nothing was opened, and the button is still there to try again.
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Import into research/ }),
    ).toBeEnabled();
  });
});

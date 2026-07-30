import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockCommands } from "../test/setup";
import { NotesPanel } from "./NotesPanel";
import { forget } from "../notes";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "0001-tier-donations",
  title: "Tier donations by amount",
  status: "ideation",
  preview: "Show the tier on the profile badge.",
  tags: [],
  created_at: 1,
  updated_at: 1,
  attachment_count: 0,
  image_count: 0,
  file_count: 0,
  pr_count: 0,
  research_count: 0,
  ...over,
});

const panel = () =>
  render(
    <NotesPanel
      projectId="p1"
      projectName="Canopy"
      roots={["/repo"]}
      onOpen={vi.fn()}
    />,
  );

describe("NotesPanel", () => {
  beforeEach(() => {
    // The module cache is shared across tests, so a note left by one would
    // show up as a phantom row in the next.
    forget("p1");
  });

  it("says how to capture when there is nothing yet", async () => {
    mockCommands({ notes_list: [] });
    panel();
    expect(
      await screen.findByText(/Write a thought above, or type one into ⌘K/),
    ).toBeInTheDocument();
  });

  it("groups notes by status, with what is moving above the raw pile", async () => {
    mockCommands({
      notes_list: [
        row(),
        row({ id: "0002-fix-dropdown", title: "Fix the dropdown", status: "doing" }),
        row({ id: "0003-rename", title: "Rename the thing", status: "ready" }),
      ],
    });
    panel();
    await screen.findByText("Fix the dropdown");

    const heads = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    // The whole reason `ready` exists is that it must not be buried under the
    // untriaged pile, so the order is part of the contract, not cosmetics.
    expect(heads[0]).toMatch(/In progress/);
    expect(heads[1]).toMatch(/Ready/);
    expect(heads[2]).toMatch(/Ideas/);
  });

  it("captures a thought with one field and one Enter", async () => {
    const create = vi.fn((_args: Record<string, unknown>) =>
      row({ id: "0004-new", title: "a new thought" }),
    );
    mockCommands({ notes_list: [], notes_create: create });
    panel();
    await screen.findByPlaceholderText("Write it down…");

    await userEvent.click(screen.getByPlaceholderText("Write it down…"));
    await userEvent.keyboard("a new thought{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    // Nothing else is asked for: no title/body split, no status, no tags. That
    // is the entire design — anything more and writing it down loses to not
    // bothering.
    expect(create.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      title: "a new thought",
      origin: "panel",
    });
  });

  it("puts the text back when the write fails", async () => {
    // Losing the thought is the one outcome this feature may never produce, so
    // an optimistic clear has to be undone rather than shrugged off.
    mockCommands({
      notes_list: [],
      notes_create: () => {
        throw new Error("disk full");
      },
    });
    panel();
    const input = await screen.findByPlaceholderText("Write it down…");

    await userEvent.click(input);
    await userEvent.keyboard("do not lose me{Enter}");

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue("do not lose me"));
  });

  it("hides the archive until asked, then fetches it", async () => {
    const list = vi.fn((args: Record<string, unknown>) =>
      (args.status as string[])?.includes("archived")
        ? [row({ id: "0009-old", title: "An old idea", status: "archived" })]
        : [row()],
    );
    mockCommands({ notes_list: list });
    panel();
    await screen.findByText("Tier donations by amount");
    expect(screen.queryByText("An old idea")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("Show archived"));
    expect(await screen.findByText("An old idea")).toBeInTheDocument();
  });
});

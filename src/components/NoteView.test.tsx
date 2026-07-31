import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockCommands } from "../test/setup";
import { NoteView } from "./NoteView";

const detail = (over: Record<string, unknown> = {}) => ({
  id: "0007-tier-donations",
  title: "Tier donations by amount",
  status: "ideation",
  preview: "",
  tags: [],
  created_at: 1,
  updated_at: 1,
  attachment_count: 0,
  image_count: 0,
  file_count: 0,
  pr_count: 0,
  research_count: 0,
  body: "Show the tier on the profile badge.",
  context: "",
  origin: "spot",
  attachments: [],
  links: { prs: [], research: [], task_runs: [], branches: [], files: [] },
  history: [],
  dir: "/home/dev/.canopy/notes/p1/0007-tier-donations",
  ...over,
});

const view = (over: Record<string, unknown> = {}, props = {}) => {
  mockCommands({ notes_get: detail(over), notes_list: [], ...(props as object) });
  return render(
    <NoteView
      projectId="p1"
      id="0007-tier-donations"
      agentTargets={[]}
      installed={{}}
      onStartNew={vi.fn()}
      onSendToAgent={vi.fn()}
    />,
  );
};

describe("NoteView", () => {
  it("shows the thought and the moves the store would accept", async () => {
    view();
    expect(await screen.findByText("Tier donations by amount")).toBeInTheDocument();
    expect(screen.getByText(/Show the tier on the profile badge/)).toBeInTheDocument();

    // From ideation: triage it, start it, put it down, file it away. Not
    // "Done" — nothing becomes done without having been worked on, and a
    // button that fails when pressed teaches the user the UI lies.
    for (const name of [/^Ready —/, /^In progress —/, /^Park it —/, /^Archive —/]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /^Done —/ })).not.toBeInTheDocument();
  });

  it("moves the note when a status button is pressed", async () => {
    const set = vi.fn((_args: Record<string, unknown>) => detail({ status: "ready" }));
    view({}, { notes_set_status: set });
    await screen.findByText("Tier donations by amount");

    await userEvent.click(screen.getByRole("button", { name: /^Ready —/ }));
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(set.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      id: "0007-tier-donations",
      status: "ready",
      by: "you",
    });
  });

  it("edits the body in place and saves it on blur", async () => {
    const update = vi.fn((_args: Record<string, unknown>) => detail());
    view({}, { notes_update: update });
    await screen.findByText(/Show the tier on the profile badge/);

    // Adding the bit you remembered afterwards is the commonest thing anyone
    // does to a parked note, so it must not need a dialog.
    await userEvent.click(screen.getByText(/Show the tier on the profile badge/));
    const box = await screen.findByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "and let maintainers opt out");
    await userEvent.tab();

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][0]).toMatchObject({
      body: "and let maintainers opt out",
    });
  });

  it("asks twice before deleting, and says what goes with it", async () => {
    const del = vi.fn(() => null);
    view(
      {
        attachments: [
          { file: "attachments/01-shot.png", kind: "image", title: "shot", origin: "pasted", bytes: 9 },
        ],
      },
      {
        notes_delete: del,
        notes_read_image: "",
      },
    );
    await screen.findByText("Tier donations by amount");

    const button = screen.getByRole("button", { name: /^Delete this note/ });
    expect(button).toHaveAttribute(
      "title",
      expect.stringContaining("1 attachment"),
    );

    await userEvent.click(button);
    // Armed, not fired — deleting is the one irreversible move here.
    expect(del).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Really?" }));
    await waitFor(() => expect(del).toHaveBeenCalledOnce());
  });

  it("puts the explanation left and the primary action hard right", async () => {
    view();
    await screen.findByText("Tier donations by amount");
    const footer = document.querySelector(".note-actions");
    const kids = [...(footer?.children ?? [])];
    // Same shape as the research tab's footer: prose, spacer, action. The eye
    // finds the action without reading the sentence first.
    expect(kids[0]).toHaveClass("note-actions-note");
    expect(kids[1]).toHaveClass("status-spacer");
    expect(kids.at(-1)?.textContent).toMatch(/Work on it/);
  });

  it("marks a captured line reference with the commit it came from", async () => {
    view({
      links: {
        prs: [],
        research: [],
        task_runs: [],
        branches: [],
        files: [
          { path: "src/PrView.tsx", start_line: 40, end_line: 52, rev: "58777d9", snapshot: null },
        ],
      },
    });
    expect(await screen.findByText("src/PrView.tsx")).toBeInTheDocument();
    expect(screen.getByText(":40-52")).toBeInTheDocument();
    // Without the rev the line numbers read as current, which after a few
    // weeks points confidently at the wrong code.
    expect(screen.getByText("@58777d9")).toBeInTheDocument();
  });

  it("keeps the captured page context folded away and labelled as history", async () => {
    view({ context: "The user is looking at: file src/x.ts." });
    const summary = await screen.findByText(
      "What was on screen when you wrote this",
    );
    // A <details> — it is often what makes an old note legible and just as
    // often noise, so it is present but not in the way.
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("says so plainly when the note is gone", async () => {
    mockCommands({
      notes_get: () => {
        throw new Error("no note there");
      },
    });
    render(
      <NoteView
        projectId="p1"
        id="0099-gone"
        agentTargets={[]}
        installed={{}}
        onStartNew={vi.fn()}
        onSendToAgent={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/could not be read — it may have been deleted/),
    ).toBeInTheDocument();
  });
});

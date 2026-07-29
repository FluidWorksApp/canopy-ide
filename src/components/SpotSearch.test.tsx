import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpotSearch } from "./SpotSearch";
import { mockCommands } from "../test/setup";
import { registerSpotSource, type SpotContext } from "../spotSources";
import type { SubTab } from "./ProjectView/helpers";

const term = (id: string, title: string, ptyId: number): SubTab => ({
  id,
  type: "terminal",
  cwd: "/repo",
  title,
  ptyId,
});

const ctx = (over: Partial<SpotContext> = {}): SpotContext => ({
  components: [{ label: "app", path: "/repo" }],
  tabs: [term("t1", "dev server", 1)],
  serverGroups: [],
  digests: [],
  projectId: "p1",
  clis: [{ id: "claude", name: "Claude Code" }],
  installed: { claude: true },
  ...over,
});

const open = (over: Partial<Parameters<typeof SpotSearch>[0]> = {}) => {
  const props = {
    ctx: ctx(),
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<SpotSearch {...props} />);
  return props;
};

beforeEach(() => {
  // The palette's open-time work: corpus fetch and index catch-up. The index
  // reports nothing new so the ingest loop stops after one call.
  mockCommands({
    fs_list_files: () => ["/repo/src/relay.ts", "/repo/src/spotSources.ts"],
    spot_ingest: () => ({ more: false, messages: 0, terminals: 0 }),
    spot_search: () => [],
    fs_search: () => [],
    spot_save_context_image: () => "/repo/.canopy/spot/ctx-1785293237.png",
  });
});

describe("SpotSearch", () => {
  it("shows actions and open tabs before anything is typed", () => {
    open();
    expect(screen.getByText("New Shell")).toBeInTheDocument();
    expect(screen.getByText("dev server")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Open Tabs")).toBeInTheDocument();
  });

  it("pins Run task first for whatever was typed, and Enter dispatches it", async () => {
    const { onAction, onClose } = open();
    await userEvent.keyboard("fix the flaky pty test");
    await userEvent.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith({
      type: "run-task",
      brief: "fix the flaky pty test",
    });
  });

  it("navigates with arrows and opens a tab row", async () => {
    const { onAction } = open();
    await userEvent.keyboard("dev ser");
    // Rows 0 and 1 are the two pinned actions a typed query always offers —
    // run it as a task, or research it — so the tab match is the third.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onAction).toHaveBeenCalledWith({ type: "focus-tab", tabId: "t1" });
  });

  it("closes on Escape without dispatching", async () => {
    const { onAction, onClose } = open();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("wraps the cursor at both ends", async () => {
    const { onAction } = open();
    // Up from the first row lands on the last one — the fastest way to the
    // bottom of a long list is one keypress.
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(onAction).toHaveBeenCalledWith({ type: "focus-tab", tabId: "t1" });
  });

  it("marks where the query matched in a title", async () => {
    open();
    await userEvent.keyboard("shell");
    const row = screen.getByRole("option", { name: /New Shell/ });
    expect(
      [...row.querySelectorAll(".spot-mark")].map((m) => m.textContent).join(""),
    ).toBe("Shell");
  });

  it("counts each section, and the results, without lying about either", () => {
    open();
    // Shell, Preview, Device and the one installed CLI, then the one open tab.
    const actions = screen.getByText("Actions").parentElement;
    expect(actions?.querySelector(".spot-group-count")?.textContent).toBe("4");
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText(/results?$/)).toHaveTextContent("5 results");
  });

  it("shows rows from a registered source and lets it open them itself", async () => {
    const run = vi.fn();
    const off = registerSpotSource({
      id: "notes",
      group: "Notes",
      timing: "instant",
      rows: ({ query }) =>
        query.includes("note")
          ? [
              {
                id: "note:1",
                group: "Notes",
                kind: "file",
                title: "standup note",
                score: 0,
                action: { type: "custom", run },
              },
            ]
          : [],
    });
    try {
      const { onAction } = open();
      await userEvent.keyboard("note");
      expect(screen.getByText("Notes")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("option", { name: /standup note/ }));
      // The palette dispatches; ProjectView is what calls run().
      expect(onAction).toHaveBeenCalledWith({ type: "custom", run });
    } finally {
      off();
    }
  });

  it("surfaces agent sessions by their prompts", async () => {
    const { onAction } = open({
      ctx: ctx({
        digests: [
          {
            session_id: "s1",
            agent: "claude",
            branch: "feat/relay",
            prompts: ["harden the relay handshake"],
          },
        ],
      }),
    });
    await userEvent.keyboard("relay handshake");
    expect(screen.getByText("Agent Sessions")).toBeInTheDocument();
    // Past both pinned action rows to the session itself.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "open-session",
        digest: expect.objectContaining({ session_id: "s1" }),
      }),
    );
  });
});

// The palette is one field over two jobs. "prview" is a search; a paragraph, or
// a pasted screenshot, is a prompt — and ranking prose against filenames
// answers a sentence with a list of things that share letters with it.
describe("SpotSearch as a composer", () => {
  const png = () => new File(["pixels"], "shot.png", { type: "image/png" });

  const paste = (files: File[]) =>
    fireEvent.paste(screen.getByRole("combobox"), {
      clipboardData: {
        items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      },
    });

  it("keeps every section for a search", async () => {
    open();
    await userEvent.keyboard("dev ser");
    expect(screen.getByText("Open Tabs")).toBeInTheDocument();
  });

  it("shows only what you can do with a sentence", async () => {
    open();
    await userEvent.keyboard("the dev server tab flickers whenever the diff gets wide, please fix it");
    expect(screen.getByText("Actions")).toBeInTheDocument();
    // The tab still matches on "dev server" — and is no longer an answer to
    // what was written.
    expect(screen.queryByText("Open Tabs")).toBeNull();
  });

  it("attaches a pasted image as a chip", async () => {
    open();
    paste([png()]);
    expect(await screen.findByText("ctx-1785293237.png")).toBeInTheDocument();
  });

  it("hands the image path to the agent, not the pixels", async () => {
    const { onAction } = open();
    paste([png()]);
    await screen.findByText("ctx-1785293237.png");
    await userEvent.keyboard("why does this look wrong?");
    await userEvent.keyboard("{Enter}");
    const brief = onAction.mock.calls[0][0].brief as string;
    expect(brief).toContain("why does this look wrong?");
    expect(brief).toContain("/repo/.canopy/spot/ctx-1785293237.png");
    expect(brief).toContain("open them with your file tools");
  });

  it("an image alone is enough to send", async () => {
    // No text at all: the brief still has to be an instruction.
    const { onAction } = open();
    paste([png()]);
    await screen.findByText("ctx-1785293237.png");
    await userEvent.keyboard("{Enter}");
    expect(onAction.mock.calls[0][0].brief).toContain("ctx-1785293237.png");
  });

  it("takes the last attachment back on Backspace", async () => {
    open();
    paste([png()]);
    await screen.findByText("ctx-1785293237.png");
    await userEvent.keyboard("{Backspace}");
    expect(screen.queryByText("ctx-1785293237.png")).toBeNull();
  });

  it("Shift+Enter writes a newline instead of sending", async () => {
    const { onAction } = open();
    await userEvent.keyboard("first line{Shift>}{Enter}{/Shift}second line");
    expect(onAction).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe(
      "first line\nsecond line",
    );
  });

  it("grows with what is typed", async () => {
    open();
    const field = () => screen.getByRole("combobox") as HTMLTextAreaElement;
    expect(field().rows).toBe(1);
    await userEvent.keyboard("one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three");
    expect(field().rows).toBe(3);
  });
});

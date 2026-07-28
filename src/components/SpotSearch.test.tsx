import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    // Row 0 is the pinned run-task action; the tab match is next.
    await userEvent.keyboard("{ArrowDown}{Enter}");
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
    // Shell, Preview and the one installed CLI, then the one open tab.
    const actions = screen.getByText("Actions").parentElement;
    expect(actions?.querySelector(".spot-group-count")?.textContent).toBe("3");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByText(/results?$/)).toHaveTextContent("4 results");
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
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "open-session",
        digest: expect.objectContaining({ session_id: "s1" }),
      }),
    );
  });
});

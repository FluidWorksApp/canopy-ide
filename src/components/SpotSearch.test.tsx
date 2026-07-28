import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpotSearch } from "./SpotSearch";
import { mockCommands } from "../test/setup";
import type { SpotContext } from "../spotSources";
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

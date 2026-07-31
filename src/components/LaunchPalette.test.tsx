import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchPalette } from "./LaunchPalette";
import { AGENT_CLIS } from "../projects";

const open = (over: Partial<Parameters<typeof LaunchPalette>[0]> = {}) => {
  const props = {
    installed: {} as Record<string, boolean>,
    cliUpdates: {},
    onShell: vi.fn(),
    onPreview: vi.fn(),
    onLaunchCli: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<LaunchPalette {...props} />);
  return props;
};

const claude = () => AGENT_CLIS.find((c) => c.id === "claude")!;

describe("LaunchPalette", () => {
  it("lists the shell, the preview and every agent CLI", () => {
    open();
    expect(screen.getByText("Shell")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    for (const cli of AGENT_CLIS) {
      expect(screen.getByText(cli.name)).toBeInTheDocument();
    }
  });

  it("opens the highlighted row on Enter — the whole point of the keyboard route", async () => {
    const { onShell, onClose } = open();
    await userEvent.keyboard("{Enter}");
    expect(onShell).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("filters as you type, and Enter launches what's left", async () => {
    const { onLaunchCli } = open();
    await userEvent.keyboard(claude().name);
    expect(screen.queryByText("Shell")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
    );
  });

  it("moves the selection with the arrow keys", async () => {
    const { onPreview } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("does not run off the end of the list", async () => {
    const { onShell } = open();
    // Up from the first row stays on the first row rather than wrapping to a
    // launch the user never aimed at.
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(onShell).toHaveBeenCalledOnce();
  });

  it("marks a CLI that isn't on PATH as an install", () => {
    open({ installed: { [claude().bin]: true } });
    // Every other CLI is missing, so the badge count is one per absent CLI.
    expect(screen.getAllByText("install")).toHaveLength(AGENT_CLIS.length - 1);
  });

  it("closes on Escape without launching anything", async () => {
    const { onClose, onShell } = open();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onShell).not.toHaveBeenCalled();
  });

  it("says nothing matched rather than showing an empty list", async () => {
    open();
    await userEvent.keyboard("zzzzz");
    expect(screen.getByText("No match")).toBeInTheDocument();
  });
});

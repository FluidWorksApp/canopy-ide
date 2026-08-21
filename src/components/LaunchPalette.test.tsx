import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchPalette } from "./LaunchPalette";
import { AGENT_CLIS } from "../projects";
import { updateSettings } from "../settings";

const open = (over: Partial<Parameters<typeof LaunchPalette>[0]> = {}) => {
  const props = {
    installed: {} as Record<string, boolean>,
    cliUpdates: {},
    onShell: vi.fn(),
    onLaunchCli: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  render(<LaunchPalette {...props} />);
  return props;
};

const claude = () => AGENT_CLIS.find((c) => c.id === "claude")!;

describe("LaunchPalette", () => {
  afterEach(() => localStorage.clear());

  it("lists the shell and every agent CLI", () => {
    open();
    expect(screen.getByText("Shell")).toBeInTheDocument();
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    for (const cli of AGENT_CLIS) {
      expect(screen.getByText(cli.name)).toBeInTheDocument();
    }
  });

  it("commits the highlighted row without invoking the cancellation path", async () => {
    const { onShell, onCancel } = open();
    await userEvent.keyboard("{Enter}");
    expect(onShell).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("filters as you type, and Enter launches what's left", async () => {
    const { onLaunchCli } = open();
    await userEvent.keyboard(claude().name);
    expect(screen.queryByText("Shell")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      "workspace",
    );
  });

  it("moves the selection with the arrow keys", async () => {
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "workspace");
  });

  it("offers an explicit current-checkout launch", async () => {
    const cli = claude();
    const { onLaunchCli } = open({ installed: { [cli.bin]: true } });
    await userEvent.click(
      screen.getByRole("button", { name: `Open ${cli.name} in the current checkout` }),
    );
    expect(onLaunchCli).toHaveBeenCalledWith(cli, "current");
  });

  it("uses Shift+Enter for the current checkout", async () => {
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Shift>}{Enter}{/Shift}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "current");
  });

  it("flips the default to the current checkout when the setting says so", async () => {
    updateSettings({ agentWorkspaces: false });
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "current");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "workspace");
  });

  it("offers a workspace launch from the hover action when the default is here", async () => {
    updateSettings({ agentWorkspaces: false });
    const cli = claude();
    const { onLaunchCli } = open({ installed: { [cli.bin]: true } });
    await userEvent.click(
      screen.getByRole("button", { name: `Open ${cli.name} in a new workspace` }),
    );
    expect(onLaunchCli).toHaveBeenCalledWith(cli, "workspace");
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
    const { onCancel, onShell } = open();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onShell).not.toHaveBeenCalled();
  });

  it("says nothing matched rather than showing an empty list", async () => {
    open();
    await userEvent.keyboard("zzzzz");
    expect(screen.getByText("No match")).toBeInTheDocument();
  });
});

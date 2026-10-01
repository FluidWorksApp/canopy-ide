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
    // ⌘N opens here: instant, where a workspace costs a worktree first.
    expect(onLaunchCli).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      "current",
    );
  });

  it("moves the selection with the arrow keys", async () => {
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "current");
  });

  it("offers an explicit new-workspace launch", async () => {
    const cli = claude();
    const { onLaunchCli } = open({ installed: { [cli.bin]: true } });
    await userEvent.click(
      screen.getByRole("button", { name: `Open ${cli.name} in a new workspace` }),
    );
    expect(onLaunchCli).toHaveBeenCalledWith(cli, "workspace");
  });

  it("uses Shift+Enter for a new workspace", async () => {
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Shift>}{Enter}{/Shift}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "workspace");
  });

  it("opens in the current checkout on a plain click", async () => {
    const cli = claude();
    const { onLaunchCli } = open({ installed: { [cli.bin]: true } });
    await userEvent.click(screen.getByText(cli.name));
    expect(onLaunchCli).toHaveBeenCalledWith(cli, "current");
  });

  it("badges install only when the probe said the CLI is missing", () => {
    open({ installed: {} });
    expect(screen.queryByText("install")).not.toBeInTheDocument();
  });

  it("defaults to a new workspace when the setting says so", async () => {
    updateSettings({ agentWorkspaceByDefault: true });
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "workspace");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "current");
  });

  it("offers a current-checkout launch from the hover action when the default is a workspace", async () => {
    updateSettings({ agentWorkspaceByDefault: true });
    const cli = claude();
    const { onLaunchCli } = open({ installed: { [cli.bin]: true } });
    await userEvent.click(
      screen.getByRole("button", { name: `Open ${cli.name} in the current checkout` }),
    );
    expect(onLaunchCli).toHaveBeenCalledWith(cli, "current");
  });

  it("ignores the retired agentWorkspaces key that saved the old default", async () => {
    // Every settings save wrote the old default back; it must not keep ⌘N
    // opening workspaces for people who never chose that.
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({ ...JSON.parse(localStorage.getItem("canopy.settings") ?? "{}"), agentWorkspaces: true }),
    );
    const { onLaunchCli } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLaunchCli).toHaveBeenCalledWith(AGENT_CLIS[0], "current");
  });

  it("overrides the default for one opening (⌘⇧N)", async () => {
    const cli = claude();
    const { onLaunchCli } = open({
      installed: { [cli.bin]: true },
      defaultWhere: "workspace",
    });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLaunchCli).toHaveBeenLastCalledWith(AGENT_CLIS[0], "workspace");
    await userEvent.click(
      screen.getByRole("button", { name: `Open ${cli.name} in the current checkout` }),
    );
    expect(onLaunchCli).toHaveBeenLastCalledWith(cli, "current");
  });

  it("does not run off the end of the list", async () => {
    const { onShell } = open();
    // Up from the first row stays on the first row rather than wrapping to a
    // launch the user never aimed at.
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(onShell).toHaveBeenCalledOnce();
  });

  it("marks a CLI that isn't on PATH as an install", () => {
    const installed = Object.fromEntries(AGENT_CLIS.map((c) => [c.bin, false]));
    installed[claude().bin] = true;
    open({ installed });
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

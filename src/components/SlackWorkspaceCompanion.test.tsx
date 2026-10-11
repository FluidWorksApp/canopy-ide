// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SlackWorkspaceCompanion } from "./SlackWorkspaceCompanion";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ws = (id: string, owner = true) => ({ id, name: `Box ${id}`, state: "ready", memory_max_mib: 1, cpu_max: 1, access: { owner, canManageAccess: owner, canStop: owner, canConnect: true } });
const backend = (workspaces: unknown[]) =>
  mocks.invoke.mockImplementation(async (cmd: string, args: { route?: string; body?: unknown }) => {
    if (cmd === "canopy_account_request" && args.route === "/api/workspaces") return { workspaces };
    if (cmd === "canopy_account_request" && args.route === "/api/slack") return { workspaceCompanion: null };
    return null;
  });
const label = "Answer Slack from my workspace when my desktop is offline";

it("turns the opt-in on for the owner's workspace through the desktop Slack hub action", async () => {
  backend([ws("member-1", false), ws("own-1")]);
  const onChange = vi.fn();
  render(<SlackWorkspaceCompanion current={null} onChange={onChange} />);
  const toggle = await screen.findByRole("switch", { name: label });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByLabelText("Workspace that answers Slack")).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(mocks.invoke).toHaveBeenCalledWith("canopy_account_request", {
    route: "/api/slack",
    body: { action: "workspace-companion", workspaceId: "own-1", enabled: true },
  });
});

it("turns it off for the workspace that has it", async () => {
  backend([ws("own-1"), ws("own-2")]);
  render(<SlackWorkspaceCompanion current={{ workspaceId: "own-2", name: "Box own-2" }} onChange={() => {}} />);
  const toggle = await screen.findByRole("switch", { name: label });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await screen.findByLabelText("Workspace that answers Slack");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("canopy_account_request", {
      route: "/api/slack",
      body: { action: "workspace-companion", workspaceId: "own-2", enabled: false },
    }),
  );
});

it("is hidden when the account owns no workspace", async () => {
  backend([ws("member-1", false)]);
  const { container } = render(<SlackWorkspaceCompanion current={null} onChange={() => {}} />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  await waitFor(() => expect(container.innerHTML).toBe(""));
});

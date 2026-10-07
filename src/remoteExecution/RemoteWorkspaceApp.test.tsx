import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RemoteWorkspaceApp } from "./RemoteWorkspaceApp";
const mocks = vi.hoisted(() => ({
  list: vi.fn(), workspace: vi.fn(), desktop: vi.fn(),
}));
vi.mock("./client", () => ({ RemoteExecutionClient: class {
  endpoint = "http://127.0.0.1:8787";
  list = mocks.list;
  workspace = mocks.workspace;
} }));
vi.mock("./RemoteTerminal", () => ({ RemoteTerminal: () => <div>remote terminal</div> }));
vi.mock("./RemoteDesktop", () => ({ RemoteDesktop: () => { mocks.desktop(); return <div>remote desktop</div>; } }));

it("opens desktop only on demand and never offers mutation to a view-only client", async () => {
  mocks.desktop.mockClear();
  mocks.list.mockResolvedValue({ principal: "reader", scope: "view", workspaces: [{ id: "team", name: "Team", accounts: [], memoryMiB: 2048, cpus: 1 }] });
  mocks.workspace.mockResolvedValue([]);
  render(<RemoteWorkspaceApp />);
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "test-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("reader");
  expect(mocks.desktop).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Open desktop" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Start agent / shell" })).toBeNull();
});

it("closing the desktop and disconnecting do not stop remote sessions", async () => {
  mocks.workspace.mockClear(); mocks.desktop.mockClear();
  mocks.list.mockResolvedValue({ principal: "writer", scope: "drive", workspaces: [{ id: "team", name: "Team", accounts: ["shared"], memoryMiB: 2048, cpus: 1 }] });
  mocks.workspace.mockResolvedValue([]);
  render(<RemoteWorkspaceApp />);
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "test-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("writer");
  // Principal display commits before the workspace initialization effect has
  // reset its views and opened the session catalog. Interact after that actual
  // readiness boundary so the test does not race the initial desktop reset.
  await waitFor(() => expect(mocks.workspace).toHaveBeenCalledWith("team", "/sessions"));
  fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
  await screen.findByText("remote desktop");
  fireEvent.click(screen.getByRole("button", { name: "Close desktop" }));
  await waitFor(() => expect(screen.queryByText("remote desktop")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(mocks.workspace.mock.calls.some(call => String(call[1]).includes("stop"))).toBe(false);
});

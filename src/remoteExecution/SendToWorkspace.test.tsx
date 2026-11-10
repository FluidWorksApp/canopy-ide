import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  dispose: vi.fn(),
  list: vi.fn(),
  setup: vi.fn(),
}));

vi.mock("./workspaceListCache", () => ({
  peekWorkspaceList: () => null,
  refreshWorkspaceList: mocks.list,
}));
vi.mock("./temporaryWorkspace", () => ({ openTemporaryWorkspace: mocks.open }));
vi.mock("./ProjectSetupDialog", () => ({
  ProjectSetupDialog: (props: { workspaceName: string; remoteInvoke: unknown }) => {
    mocks.setup(props);
    return <div>setup for {props.workspaceName}</div>;
  },
}));

import { SendToWorkspace, sendTargets } from "./SendToWorkspace";

const w = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), state: "ready", memory_max_mib: 1, cpu_max: 1, ...over }) as never;

beforeEach(() => {
  mocks.open.mockReset().mockResolvedValue({ workspaceName: "Coraa Workstation", invoke: vi.fn(), dispose: mocks.dispose });
  mocks.dispose.mockReset();
  mocks.setup.mockReset();
  mocks.list.mockReset().mockResolvedValue({ workspaces: [w("ws1"), w("ws2", { state: "stopped" }), w("ws3", { access: { canConnect: false } })] });
});

describe("sendTargets", () => {
  it("keeps ready workspaces this account can connect to", () => {
    expect(sendTargets([w("a"), w("b", { state: "hibernated" }), w("c", { access: { canConnect: false } })]).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("SendToWorkspace", () => {
  const view = () => render(<SendToWorkspace projectId="p1" projectName="Canopy" components={[{ componentId: "c1", label: "canopy" }]} />);

  it("offers only workspaces it can send to, then hands the setup a temporary connection", async () => {
    view();
    const group = await screen.findByRole("radiogroup", { name: "Workspace" });
    expect(group.querySelectorAll("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("radio", { name: "WS1" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("setup for Coraa Workstation")).toBeInTheDocument();
    expect(mocks.open).toHaveBeenCalledWith("ws1");
    expect(mocks.setup.mock.calls[0][0].remoteInvoke).toBeTypeOf("function");
  });

  it("lets go of the connection when it goes away", async () => {
    const { unmount } = view();
    await userEvent.click(await screen.findByRole("radio", { name: "WS1" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/setup for/);
    unmount();
    expect(mocks.dispose).toHaveBeenCalled();
  });

  it("says why when it cannot connect, and keeps the choice", async () => {
    mocks.open.mockRejectedValueOnce(new Error("stopped"));
    view();
    await userEvent.click(await screen.findByRole("radio", { name: "WS1" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not connect: stopped"));
    expect(screen.getByRole("radio", { name: "WS1" })).toHaveAttribute("aria-checked", "true");
  });
});

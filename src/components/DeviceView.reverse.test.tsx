import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import DeviceView from "./DeviceView";

const mocks = vi.hoisted(() => ({
  reverse: vi.fn(),
  remove: vi.fn(),
  ports: [3000, 5173] as number[],
}));

vi.mock("./AgentLaunchButton", () => ({ AgentLaunchButton: () => <button>Mock agent launch</button> }));
vi.mock("../ipc", () => ({
  androidSdkStatus: async () => ({ sdk: true, missing: [] }),
  androidDevices: async () => [],
  androidAvds: async () => [],
  androidScreencap: async () => {
    throw new Error("no frame");
  },
  androidReverse: mocks.reverse,
  androidReverseRemove: mocks.remove,
}));
vi.mock("../remoteExecution/workspace", () => ({
  activeWorkspace: () => ({ forwardedLoopbackPorts: () => mocks.ports }),
}));
vi.mock("../devices/deviceHub", () => ({
  deviceHubAttach: vi.fn(),
  deviceHubBoot: vi.fn(),
  deviceHubDeclined: () => true,
  deviceHubDevices: async () => [],
  deviceHubStart: async () => ({ installed: false, running: false, platforms: [] }),
  deviceHubStatus: async () => ({ installed: false, running: false, platforms: [] }),
  setDeviceHubDeclined: vi.fn(),
  useDeviceHubAccess: () => ({ access: null, refresh: vi.fn() }),
}));
vi.mock("../devices/DeviceStreamView", () => ({ DeviceStreamView: () => null }));

const view = (visible = true) => (
  <DeviceView
    serial="emulator-5554"
    projectDir="/repo"
    annotations={[]}
    visible={visible}
    onPatch={vi.fn()}
    agentTargets={[]}
    installed={{}}
    onSendToAgent={vi.fn()}
    onStartNew={vi.fn(async () => true)}
    projects={[{ label: "Canopy", path: "/repo" }]}
  />
);

beforeEach(() => {
  mocks.reverse.mockReset().mockImplementation(async (_serial: string, ports: number[]) => ports);
  mocks.remove.mockReset().mockResolvedValue(undefined);
});

it("reverses a remote workspace's forwarded ports onto the device and says so", async () => {
  render(view());
  await waitFor(() => expect(mocks.reverse).toHaveBeenCalledWith("emulator-5554", [3000, 5173], "/repo"));
  expect(await screen.findByText(/Workspace ports on this device: 3000, 5173/)).toBeInTheDocument();
});

it("undoes the mappings when the tab goes away", async () => {
  const { unmount } = render(view());
  await waitFor(() => expect(mocks.reverse).toHaveBeenCalled());
  await screen.findByText(/Workspace ports on this device/);
  unmount();
  expect(mocks.remove).toHaveBeenCalledWith("emulator-5554", [3000, 5173], "/repo");
});

it("does nothing while the tab is hidden", async () => {
  render(view(false));
  await new Promise((r) => setTimeout(r, 50));
  expect(mocks.reverse).not.toHaveBeenCalled();
});

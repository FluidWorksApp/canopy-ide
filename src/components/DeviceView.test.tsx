import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DeviceAnnotation } from "../android";
import DeviceView from "./DeviceView";

const mocks = vi.hoisted(() => ({ placement: vi.fn() }));

vi.mock("./AgentLaunchButton", () => ({
  AgentLaunchButton: (props: { placement?: unknown }) => {
    mocks.placement(props.placement);
    return <button>Mock agent launch</button>;
  },
}));
vi.mock("../ipc", () => ({
  androidSdkStatus: async () => ({ sdk: false, missing: [] }),
  androidDevices: async () => [],
  androidAvds: async () => [],
}));
vi.mock("../devices/deviceHub", () => ({
  deviceHubAttach: vi.fn(),
  deviceHubBoot: vi.fn(),
  deviceHubDeclined: () => true,
  deviceHubDevices: async () => [],
  deviceHubStart: async () => ({ installed: false, running: false }),
  deviceHubStatus: async () => ({ installed: false, running: false }),
  setDeviceHubDeclined: vi.fn(),
  useDeviceHubAccess: () => ({ access: null, refresh: vi.fn() }),
}));
vi.mock("../devices/DeviceStreamView", () => ({ DeviceStreamView: () => null }));

const annotation: DeviceAnnotation = {
  n: 1,
  serial: "emulator-5554",
  component: "app/MainActivity",
  resourceId: "",
  className: "android.view.View",
  text: "",
  contentDesc: "",
  clickable: true,
  bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
  comment: "Move this button",
};

it("passes placement through the device feedback launch boundary", () => {
  const placement = { project: { id: "p1", name: "Canopy", components: [] } };
  render(
    <DeviceView
      serial="emulator-5554"
      projectDir="/repo"
      annotations={[annotation]}
      visible={false}
      onPatch={vi.fn()}
      agentTargets={[]}
      installed={{ opencode: true }}
      placement={placement}
      onSendToAgent={vi.fn()}
      onStartNew={vi.fn(async () => true)}
      projects={[{ label: "Canopy", path: "/repo" }]}
    />,
  );

  expect(screen.getByRole("button", { name: "Mock agent launch" })).toBeInTheDocument();
  expect(mocks.placement).toHaveBeenCalledWith(placement);
});

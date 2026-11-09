import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PreviewAnnotation } from "../preview";
import { PreviewView } from "./PreviewView";

const mocks = vi.hoisted(() => ({ placement: vi.fn() }));

vi.mock("./AgentLaunchButton", () => ({
  AgentLaunchButton: (props: { placement?: unknown }) => {
    mocks.placement(props.placement);
    return <button>Mock agent launch</button>;
  },
}));
vi.mock("../remoteExecution/workspace", () => ({ activeWorkspace: () => null }));
vi.mock("../previewEngine", () => ({ previewEngine: () => null }));
vi.mock("../browserTransport", () => ({ transportFor: () => null }));
vi.mock("../browserHost", () => ({
  browserPageChanged: vi.fn(),
  browserViewChanged: vi.fn(),
  forgetBrowserView: vi.fn(),
  refreshBrowserViews: vi.fn(),
  registerBrowserView: vi.fn(),
  setBrowserViewWanted: vi.fn(),
  themeRgb: () => ({ r: 0, g: 0, b: 0 }),
  useBrowserEngine: () => null,
  useBrowserPane: () => ({ state: "idle", frame: null }),
}));
vi.mock("../previewAgent", () => ({ registerBrowserTarget: () => () => {} }));
vi.mock("../vibePreviewContext", () => ({
  publishVibePreviewContext: vi.fn(),
  removeVibePreviewContext: vi.fn(),
}));
vi.mock("../settings", () => ({
  getSettings: () => ({ previewCaptureMode: "viewport" }),
  updateSettings: vi.fn(),
}));
vi.mock("../ipc", () => ({}));
vi.mock("./PreviewLauncher", () => ({ PreviewLauncher: () => null }));
vi.mock("./OpenInBrowserButton", () => ({ OpenInBrowserButton: () => null }));

const annotation: PreviewAnnotation = {
  n: 1,
  selector: "button",
  tag: "button",
  id: null,
  classes: "primary",
  text: "Save",
  html: "<button>Save</button>",
  components: [],
  rect: { x: 0, y: 0, w: 100, h: 30 },
  pageUrl: "http://localhost:3000",
  pageTitle: "App",
  comment: "Move this button",
};

it("passes placement through the preview feedback launch boundary", () => {
  const placement = { project: { id: "p1", name: "Canopy", components: [] } };
  render(
    <PreviewView
      tabId="preview-1"
      projectId="p1"
      url="http://localhost:3000"
      annotations={[annotation]}
      shots={[]}
      dir="/repo"
      visible={false}
      onPatch={vi.fn()}
      servers={[]}
      agentTargets={[]}
      installed={{ opencode: true }}
      placement={placement}
      onSendToAgent={vi.fn()}
      onStartNew={vi.fn(async () => true)}
      onRunOneOff={vi.fn()}
      onNotice={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "Mock agent launch" })).toBeInTheDocument();
  expect(mocks.placement).toHaveBeenCalledWith(placement);
});

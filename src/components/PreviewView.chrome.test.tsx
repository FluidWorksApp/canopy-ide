// @vitest-environment jsdom
// The Chrome engine inside PreviewView: agent ops go to the host and back to
// the bridge, a tab the host closed reconnects, and a page Chrome will not open
// falls back to the embedded browser with the host's reason.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewView } from "./PreviewView";

const mocks = vi.hoisted(() => ({
  target: null as null | ((op: Record<string, unknown>) => void),
  previewOp: vi.fn(),
  previewStreamUrl: vi.fn(),
  browserResult: vi.fn(async () => {}),
  surfaces: [] as Array<Record<string, unknown>>,
}));

vi.mock("./AgentLaunchButton", () => ({ AgentLaunchButton: () => null }));
vi.mock("../remoteExecution/workspace", () => ({ activeWorkspace: () => null }));
vi.mock("../previewEngine", () => ({ previewEngine: () => "proxy" }));
vi.mock("../browserTransport", () => ({ transportFor: () => null }));
vi.mock("../browserHost", () => ({
  browserPageChanged: vi.fn(),
  browserViewChanged: vi.fn(),
  forgetBrowserView: vi.fn(),
  refreshBrowserViews: vi.fn(),
  registerBrowserView: vi.fn(),
  setBrowserViewWanted: vi.fn(),
  themeRgb: () => ({ r: 0, g: 0, b: 0 }),
  useBrowserEngine: () => "proxy",
  useBrowserPane: () => ({ state: "idle", frame: null }),
}));
vi.mock("../previewAgent", () => ({
  registerBrowserTarget: (_tabId: string, run: (op: Record<string, unknown>) => void) => {
    mocks.target = run;
    return () => {};
  },
}));
vi.mock("../vibePreviewContext", () => ({ publishVibePreviewContext: vi.fn(), removeVibePreviewContext: vi.fn() }));
vi.mock("../settings", () => ({
  getSettings: () => ({ previewCaptureMode: "viewport", previewChrome: true }),
  updateSettings: vi.fn(),
}));
vi.mock("../ipc", () => ({ browserResult: mocks.browserResult, previewStart: vi.fn(() => new Promise(() => {})), previewStop: vi.fn() }));
vi.mock("./PreviewLauncher", () => ({ PreviewLauncher: () => null }));
vi.mock("./OpenInBrowserButton", () => ({ OpenInBrowserButton: () => null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../previewHost", () => {
  class PreviewHostError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const ready = { status: "ready", info: { port: 1, token: "t", executable: "/chrome" } };
  return {
    PreviewHostError,
    previewHostState: () => ready,
    subscribePreviewHost: () => () => {},
    startPreviewHost: vi.fn(async () => ready.info),
    retryPreviewHost: vi.fn(async () => ready.info),
    previewProfile: (projectId: string) => `p-${projectId}`,
    previewOp: mocks.previewOp,
    previewStreamUrl: mocks.previewStreamUrl,
    keepPreviewTab: vi.fn(),
    closePreviewTabSoon: vi.fn(),
  };
});
vi.mock("../remoteExecution/StreamSurface", () => ({
  StreamSurface: (props: Record<string, unknown>) => {
    mocks.surfaces.push(props);
    return <div data-testid="surface" data-key={String(props.connectKey)} />;
  },
}));

beforeEach(() => {
  mocks.surfaces.length = 0;
  mocks.previewOp.mockReset();
  mocks.previewStreamUrl.mockReset();
  mocks.browserResult.mockClear();
});
afterEach(() => vi.useRealTimers());

const mount = () =>
  render(
    <PreviewView
      tabId="tab-1"
      projectId="proj"
      url="http://localhost:3000/"
      annotations={[]}
      shots={[]}
      dir="/repo"
      visible
      onPatch={vi.fn()}
      servers={[]}
      agentTargets={[]}
      installed={{}}
      onSendToAgent={vi.fn()}
      onStartNew={vi.fn(async () => true)}
      onRunOneOff={vi.fn()}
      onNotice={vi.fn()}
    />,
  );

it("runs an agent's op in the host and answers the bridge with its result", async () => {
  mount();
  expect(screen.getByTestId("surface")).toBeTruthy();
  mocks.previewOp.mockResolvedValueOnce({ clicked: true });
  act(() => mocks.target?.({ id: 7, op: "click", ref: 3, selector: null }));
  await waitFor(() => expect(mocks.browserResult).toHaveBeenCalledWith(7, true, { clicked: true }));
  expect(mocks.previewOp).toHaveBeenCalledWith("tab-1", "click", { ref: 3 }, { url: "http://localhost:3000/", profile: "p-proj" });

  // A person holding the page refuses the agent's write with the host's reason.
  mocks.previewOp.mockRejectedValueOnce(new Error("A human controls this tab."));
  act(() => mocks.target?.({ id: 8, op: "type", ref: 3, text: "x" }));
  await waitFor(() => expect(mocks.browserResult).toHaveBeenCalledWith(8, false, "A human controls this tab."));
});

it("reconnects when the host closes the tab under the viewer", async () => {
  vi.useFakeTimers();
  mount();
  const first = mocks.surfaces.length;
  act(() => (mocks.surfaces.at(-1)!.onGone as () => void)());
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  expect(mocks.surfaces.length).toBeGreaterThan(first);
});

it("falls back to the embedded browser with the host's reason when Chrome cannot open the page", async () => {
  const { PreviewHostError } = await import("../previewHost");
  mocks.previewStreamUrl.mockRejectedValue(new PreviewHostError(409, "Another copy of Canopy is using this preview profile."));
  mount();
  const streamUrl = mocks.surfaces.at(-1)!.streamUrl as (path: string) => Promise<string>;
  await act(async () => {
    await streamUrl("/browser/stream?maxWidth=1&maxHeight=1").catch(() => {});
  });
  expect(screen.getByRole("status").textContent).toContain("Another copy of Canopy is using this preview profile.");
  expect(screen.queryByTestId("surface")).toBeNull();
});

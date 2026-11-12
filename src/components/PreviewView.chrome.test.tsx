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
  browser: { executable: "/chrome", installer: null } as { executable: string; installer: Record<string, unknown> | null },
  dismissed: false,
  listeners: new Set<() => void>(),
  install: vi.fn(async () => {}),
}));
const notify = () => mocks.listeners.forEach((listener) => listener());

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
    subscribePreviewHost: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    previewBrowserState: () => mocks.browser,
    browserOfferDismissed: () => mocks.dismissed,
    dismissBrowserOffer: () => {
      mocks.dismissed = true;
      notify();
    },
    installPreviewBrowser: mocks.install,
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
  mocks.browser = { executable: "/chrome", installer: null };
  mocks.dismissed = false;
  mocks.install.mockClear();
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

it("offers Chromium where there is no Chrome, and the embedded browser serves meanwhile", async () => {
  const { fireEvent } = await import("@testing-library/react");
  mocks.browser = { executable: "", installer: { state: "missing", received: 0, total: 99_928_434, version: "153.0.8010.12" } };
  mount();
  // No Chrome stream: the page is the embedded one.
  expect(screen.queryByTestId("surface")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("No Chrome found — logins won't stick here.");
  fireEvent.click(screen.getByRole("button", { name: "Download Chromium (~100 MB)" }));
  expect(mocks.install).toHaveBeenCalledTimes(1);

  // Progress, then failure with a retry.
  act(() => {
    mocks.browser = { executable: "", installer: { state: "downloading", received: 42_000_000, total: 99_928_434, version: "153" } };
    notify();
  });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Downloading Chromium… 42% of 100 MB"));
  act(() => {
    mocks.browser = { executable: "", installer: { state: "failed", received: 0, total: 99_928_434, version: "153", error: "network unreachable" } };
    notify();
  });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Download failed: network unreachable"));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(mocks.install).toHaveBeenCalledTimes(2);

  // Done: every preview switches to Chrome.
  act(() => {
    mocks.browser = { executable: "/browsers/chromium_headless_shell-1243/chrome-headless-shell", installer: { state: "installed", received: 1, total: 1, version: "153" } };
    notify();
  });
  await waitFor(() => expect(screen.getByTestId("surface")).toBeTruthy());
  expect(screen.queryByRole("status")).toBeNull();
});

it("hides the offer for the session on Not now, and says to install Chrome where Chromium has no build", async () => {
  const { fireEvent, cleanup } = await import("@testing-library/react");
  mocks.browser = { executable: "", installer: { state: "missing", received: 0, total: 1, version: "1" } };
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  cleanup();

  mocks.dismissed = false;
  mocks.browser = { executable: "", installer: { state: "unsupported", received: 0, total: 0, version: "1" } };
  mount();
  expect(screen.getByRole("status").textContent).toContain("Install Google Chrome to keep them.");
  expect(screen.queryByRole("button", { name: /Download Chromium/ })).toBeNull();
});

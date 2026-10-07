import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import * as ipc from "../ipc";

vi.mock("../ipc", () => ({
  gitStatus: vi.fn(),
  onGitChange: vi.fn(),
  gitBranches: vi.fn(),
  gitCheckout: vi.fn(),
  claudeSessionStats: vi.fn(),
  opencodeSessionStats: vi.fn(),
  onAppStats: vi.fn(),
  onPtyStats: vi.fn(),
  agentUsage: vi.fn(),
  planUsage: vi.fn(),
  profilesList: vi.fn(),
  profileActivate: vi.fn(),
  profileAccounts: vi.fn(),
  gitSyncProbe: vi.fn(),
  gitSyncApply: vi.fn(),
  gitSyncAbort: vi.fn(),
  cleanupDisk: vi.fn(),
}));

const noSub = async () => () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.gitStatus).mockResolvedValue({
    is_repo: true,
    branch: "main",
    entries: [],
  } as never);
  vi.mocked(ipc.gitBranches).mockResolvedValue([]);
  vi.mocked(ipc.onGitChange).mockImplementation(noSub as never);
  vi.mocked(ipc.gitSyncProbe).mockResolvedValue(null as never);
  vi.mocked(ipc.onAppStats).mockImplementation(noSub as never);
  vi.mocked(ipc.onPtyStats).mockImplementation(noSub as never);
  vi.mocked(ipc.agentUsage).mockResolvedValue([]);
  vi.mocked(ipc.planUsage).mockResolvedValue([]);
  vi.mocked(ipc.profilesList).mockResolvedValue([]);
  vi.mocked(ipc.profileAccounts).mockResolvedValue([]);
  vi.mocked(ipc.cleanupDisk).mockResolvedValue([]);
  vi.mocked(ipc.opencodeSessionStats).mockResolvedValue(null);
});

it("opens the usage panel in <body>, inside the window, and closes it on an outside click", async () => {
  const { container } = render(
    <StatusBar
      roots={["/repo"]}
      agents={[]}
      visible
      projects={[{ name: "canopy", roots: ["/repo"] }]}
      events={[]}
    />,
  );
  const btn = container.querySelector(".status-stats-btn") as HTMLElement;
  // jsdom lays nothing out; give the chip a real spot near the bottom-right.
  btn.getBoundingClientRect = () =>
    ({ top: 740, bottom: 760, left: 990, right: 1006, width: 16, height: 20 }) as DOMRect;
  Object.assign(window, { innerWidth: 1024, innerHeight: 768 });
  fireEvent.click(btn);

  const menu = document.body.querySelector(".status-stats-menu") as HTMLElement;
  expect(menu).not.toBeNull();
  // Portalled: not inside the status bar's stacking context.
  expect(container.contains(menu)).toBe(false);
  expect(menu.style.position).toBe("fixed");
  expect(menu.style.left).toBe(`${1006 - 452}px`);
  expect(menu.style.bottom).toBe(`${768 - 740 + 6}px`);
  expect(menu.style.maxHeight).toBe(`${740 - 6 - 8}px`);

  // A click inside the portalled panel is not an outside click.
  fireEvent.mouseDown(menu);
  expect(document.body.querySelector(".status-stats-menu")).not.toBeNull();

  // Re-measured on resize.
  Object.assign(window, { innerHeight: 500 });
  btn.getBoundingClientRect = () =>
    ({ top: 472, bottom: 492, left: 990, right: 1006, width: 16, height: 20 }) as DOMRect;
  fireEvent(window, new Event("resize"));
  expect(menu.style.maxHeight).toBe(`${472 - 6 - 8}px`);

  fireEvent.mouseDown(document.body);
  expect(document.body.querySelector(".status-stats-menu")).toBeNull();
  await screen.findByText(/main/);
});

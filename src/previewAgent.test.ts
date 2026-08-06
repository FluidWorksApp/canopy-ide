import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ browserResult: vi.fn(() => Promise.resolve()) }));

import * as ipc from "./ipc";
import {
  MAX_QUEUED_BROWSER_OPS_PER_TAB,
  MAX_QUEUED_BROWSER_TABS,
  dispatchBrowserOp,
  forgetBrowserTarget,
  registerBrowserTarget,
} from "./previewAgent";

const op = (id: number): ipc.AgentBrowserOp => ({
  id,
  op: "snapshot",
  route: "/snapshot",
});

afterEach(() => {
  vi.mocked(ipc.browserResult).mockClear();
  for (let i = 0; i < MAX_QUEUED_BROWSER_TABS + 2; i += 1) {
    forgetBrowserTarget(`tab-${i}`);
  }
  forgetBrowserTarget("one");
  vi.mocked(ipc.browserResult).mockClear();
});

describe("preview agent queue bounds", () => {
  it("rejects the oldest operation when one unmounted preview is saturated", () => {
    for (let i = 0; i <= MAX_QUEUED_BROWSER_OPS_PER_TAB; i += 1) {
      dispatchBrowserOp("one", op(i));
    }
    expect(ipc.browserResult).toHaveBeenCalledWith(0, false, expect.any(String));

    const handled: number[] = [];
    const unregister = registerBrowserTarget("one", (queued) => handled.push(queued.id));
    expect(handled).toHaveLength(MAX_QUEUED_BROWSER_OPS_PER_TAB);
    expect(handled[0]).toBe(1);
    unregister();
  });

  it("rejects queues belonging to the stalest unmounted tab", () => {
    for (let i = 0; i <= MAX_QUEUED_BROWSER_TABS; i += 1) {
      dispatchBrowserOp(`tab-${i}`, op(i));
    }
    expect(ipc.browserResult).toHaveBeenCalledWith(0, false, expect.any(String));

    const handled: number[] = [];
    const unregister = registerBrowserTarget("tab-0", (queued) => handled.push(queued.id));
    expect(handled).toEqual([]);
    unregister();
  });
});

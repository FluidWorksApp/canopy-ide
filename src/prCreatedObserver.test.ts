import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ onStoreChange: vi.fn(() => new Promise<never>(() => {})) }));

import { __reset, observePrCreated } from "./prCreatedObserver";
import type { AgentEventData } from "../shared/notifications";

const event = (url: string, extra: Partial<AgentEventData> = {}): AgentEventData => ({
  sessionId: "s1",
  cwd: "/wt/a",
  pty: null,
  event: "PostToolUse",
  tool: "Bash",
  agent: "",
  prCreated: { url },
  ...extra,
});

const URL = "https://github.com/o/r/pull/571";
const pr = { url: URL, branch: "release/x" };
const digest = { session_id: "s1", agent: "claude", profile: "work", branch: "t3/a" };

function deps(over: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => [pr] as never),
    digest: vi.fn(async () => digest as never),
    wait: vi.fn(async () => {}),
    record: vi.fn(async () => true),
    ...over,
  };
}

beforeEach(() => __reset());

describe("observePrCreated", () => {
  it("records the PR under the session, with the PR's own head branch and the session's profile", async () => {
    const d = deps();
    await observePrCreated([event(URL)], d);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL, branch: "release/x", sessionId: "s1", profile: "work", agent: "claude", via: "pr_watch" }),
    );
  });
  it("records nothing for a PR this repo does not list (another repo)", async () => {
    const d = deps({ list: vi.fn(async () => [] as never) });
    await observePrCreated([event(URL)], d);
    expect(d.record).not.toHaveBeenCalled();
  });
  it("retries the list once when GitHub lags the create", async () => {
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([pr]);
    const d = deps({ list });
    await observePrCreated([event(URL)], d);
    expect(list).toHaveBeenCalledTimes(2);
    expect(d.record).toHaveBeenCalledTimes(1);
  });
  it("records nothing without the session's digest", async () => {
    const d = deps({ digest: vi.fn(async () => undefined) });
    await observePrCreated([event(URL)], d);
    expect(d.record).not.toHaveBeenCalled();
  });
  it("does not record the same PR twice, and skips events without one", async () => {
    const d = deps();
    await observePrCreated([event(URL), event(URL), { ...event(URL), prCreated: undefined }, null], d);
    expect(d.record).toHaveBeenCalledTimes(1);
  });
});

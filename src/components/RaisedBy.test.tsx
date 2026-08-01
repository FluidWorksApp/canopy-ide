import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProvenanceEdge } from "../ipc";

const edges: ProvenanceEdge[] = [];

vi.mock("../ipc", () => ({
  fsStat: vi.fn(async () => ({ is_dir: true, size: 0, modified_ms: null })),
  onStoreChange: vi.fn(() => new Promise<never>(() => {})),
  provenanceForPr: vi.fn(async () => edges),
  provenanceBackfill: vi.fn(async () => ({
    scanned: 0,
    matched: 0,
    recorded: 0,
    unattributable: 0,
  })),
}));

import { RaisedBy } from "./RaisedBy";

const edge = (over: Partial<ProvenanceEdge> = {}): ProvenanceEdge => ({
  repo: "/repo",
  pr_number: 42,
  pr_url: "https://github.com/o/n/pull/42",
  branch: "feat/x",
  session_id: "s1",
  agent: "claude",
  profile: "default",
  cwd: "/repo/wt",
  via: "job_done",
  at: Math.floor(Date.now() / 1000) - 3600,
  confidence: "declared",
  ...over,
});

const show = (rows: ProvenanceEdge[], live = new Map<string, number | null>()) => {
  edges.length = 0;
  edges.push(...rows);
  const onSend = vi.fn();
  render(<RaisedBy repo="/repo" number={42} live={live} onSend={onSend} />);
  return onSend;
};

describe("the PR tab's raised-by row", () => {
  // A PR a human pushed has no edge, and a row saying "we don't know" on every
  // one of those is noise on a header that is already dense.
  it("renders nothing when no session was ever recorded", async () => {
    show([]);
    await waitFor(() => expect(screen.queryByText(/raised by/)).toBeNull());
  });

  it("names the agent and says it is running", async () => {
    show([edge()], new Map([["s1", 6]]));
    expect(await screen.findByText("claude")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("sends the typed change to the resolved session", async () => {
    const onSend = show([edge()], new Map([["s1", 6]]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /send a change/i }));
    await user.type(screen.getByRole("textbox"), "drop the retry{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const [to, text] = onSend.mock.calls[0];
    expect(to.kind).toBe("live");
    expect(to.ptyId).toBe(6);
    expect(text).toBe("drop the retry");
  });

  // Nothing this window can type into, and resuming a running conversation
  // would put a second process on one session id.
  it("offers no action for a session in another window", async () => {
    show([edge()], new Map([["s1", null]]));
    expect(await screen.findByText("another window")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers to pick up a PR whose conversation is gone", async () => {
    const ipc = await import("../ipc");
    (ipc.fsStat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("gone"),
    );
    show([edge({ cwd: "/gone" })]);
    expect(await screen.findByRole("button", { name: /pick up/i })).toBeTruthy();
    expect(screen.getByText("closed")).toBeTruthy();
  });
});

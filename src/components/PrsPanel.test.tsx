import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ipc from "../ipc";
import { PrsPanel } from "./PrsPanel";

const gitPrMergeProbe = vi.fn();
const ghPrRetarget = vi.fn();
const refresh = vi.fn();
const loadProvenance = vi.fn();

const row = (over: Partial<ipc.PrRow> = {}): ipc.PrRow => ({
  repo: "/repo",
  nwo: "o/r",
  number: 1,
  title: "Foundation",
  author: "alice",
  url: "https://github.com/o/r/pull/1",
  branch: "feat/foundation",
  base: "main",
  head_sha: "1".repeat(40),
  base_sha: "a".repeat(40),
  draft: false,
  created: "2026-08-01T00:00:00Z",
  updated: "2026-08-08T00:00:00Z",
  additions: 10,
  deletions: 2,
  mergeable: "MERGEABLE",
  review_decision: "APPROVED",
  checks: "PASS",
  comments: 0,
  threads: 0,
  requested_from_me: false,
  mine: false,
  ...over,
});

const rows = [
  row(),
  row({
    number: 2,
    title: "Dependent feature",
    branch: "feat/dependent",
    head_sha: "2".repeat(40),
  }),
];

vi.mock("../usePrWatch", () => ({
  usePrWatch: () => ({
    rows,
    fetchedMs: Date.now(),
    errors: {},
    remaining: 4_000,
    nextIn: 90,
    busy: false,
    viewer: "me",
  }),
}));

vi.mock("../prWatchStore", () => ({ refresh: () => refresh() }));

vi.mock("../ipc", async (original) => {
  const actual = await original<typeof import("../ipc")>();
  return {
    ...actual,
    gitPrMergeProbe: (...args: unknown[]) => gitPrMergeProbe(...args),
    ghPrRetarget: (...args: unknown[]) => ghPrRetarget(...args),
  };
});

vi.mock("../provenance", () => ({
  PROVENANCE_EVENT: "canopy:provenance",
  cached: (_repo: string, number: number) => [{
    repo: "/repo",
    pr_number: number,
    pr_url: `https://github.com/o/r/pull/${number}`,
    branch: "feat/x",
    session_id: `session${number}`,
    agent: "codex",
    cwd: "/repo",
    via: "pr_watch",
    at: number,
    confidence: "observed",
  }],
  load: (...args: unknown[]) => loadProvenance(...args),
}));

describe("PrsPanel dashboard", () => {
  beforeEach(() => {
    gitPrMergeProbe.mockReset().mockResolvedValue({
      repo: "/repo",
      unavailable: [],
      fetch_error: null,
      pairs: [{
        first: 1,
        second: 2,
        clean: true,
        conflicts: [],
        first_ancestor_second: true,
        second_ancestor_first: false,
      }],
    });
    ghPrRetarget.mockReset().mockResolvedValue("Stacked #2 on feat/foundation");
    refresh.mockReset();
    loadProvenance.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders a deterministic native dashboard and only stacks on a confirmed click", async () => {
    const onOpen = vi.fn();
    render(
      <PrsPanel
        page
        localRepos={["/repo"]}
        onOpen={onOpen}
      />,
    );

    const stack = await screen.findByRole("button", { name: "Stack on #1" });
    expect(screen.getByText("Main · Features")).toBeInTheDocument();
    // The row names its repo (the leaf of owner/name), not the project: in a
    // multi-repo project the project name said nothing about where a PR lives.
    expect(screen.getAllByText("r").length).toBeGreaterThan(0);
    expect(screen.getByText("codex · session1")).toBeInTheDocument();
    expect(screen.getAllByTitle("Recommended landing order")[0]).toHaveTextContent("1");

    fireEvent.click(screen.getByText("Foundation"));
    expect(onOpen).toHaveBeenCalledWith("/repo", expect.objectContaining({ number: 1 }));

    fireEvent.click(stack);
    await waitFor(() =>
      expect(ghPrRetarget).toHaveBeenCalledWith("/repo", 2, "feat/foundation"),
    );
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

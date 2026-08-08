import { describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import {
  categoryOf,
  dashboardGroups,
  indexProbes,
  mergeProbeGroups,
  openAge,
  recommendMergeOrder,
  sessionLabel,
} from "./prDashboard";

const sha = (n: string) => n.repeat(40).slice(0, 40);
const row = (over: Partial<ipc.PrRow> = {}): ipc.PrRow => ({
  repo: "/repo",
  nwo: "o/r",
  number: 1,
  title: "Feature",
  author: "alice",
  url: "https://github.com/o/r/pull/1",
  branch: "feat/one",
  base: "main",
  head_sha: sha("1"),
  base_sha: sha("a"),
  draft: false,
  created: "2026-08-01T00:00:00Z",
  updated: "2026-08-01T00:00:00Z",
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

describe("dashboard categories", () => {
  it("derives target, substrate, research and stacks from stable row facts", () => {
    const rows = [
      row(),
      row({ number: 2, branch: "fix/runtime-memory", base: "feat/vibe-build-setup" }),
      row({ number: 3, branch: "docs/research-map" }),
      row({ number: 4, branch: "feat/child", base: "feat/one" }),
    ];
    expect(rows.map((r) => categoryOf(r, rows))).toEqual([
      "main-feature",
      "build-substrate",
      "research",
      "stack",
    ]);
    expect(dashboardGroups(rows).map((g) => g.id)).toEqual([
      "build-substrate",
      "main-feature",
      "research",
      "stack",
    ]);
  });

  it("groups probes only where repo, category and base agree", () => {
    const groups = mergeProbeGroups([
      row(),
      row({ number: 2, branch: "feat/two", head_sha: sha("2") }),
      row({ repo: "/other", number: 3, head_sha: sha("3") }),
      row({ number: 4, branch: "docs/note", head_sha: sha("4") }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates.map((c) => c.number)).toEqual([1, 2]);
  });
});

describe("merge recommendation", () => {
  it("obeys ancestry before readiness and uses PR number as the stable tie break", () => {
    const rows = [
      row({ number: 9, branch: "feat/base", head_sha: sha("9"), review_decision: "" }),
      row({ number: 3, branch: "feat/child", head_sha: sha("3") }),
      row({ number: 5, branch: "feat/peer", head_sha: sha("5") }),
    ];
    const probe: ipc.PrMergePlanProbe = {
      repo: "/repo",
      unavailable: [],
      fetch_error: null,
      pairs: [
        { first: 3, second: 9, clean: true, conflicts: [], first_ancestor_second: false, second_ancestor_first: true },
        { first: 3, second: 5, clean: true, conflicts: [], first_ancestor_second: false, second_ancestor_first: false },
        { first: 5, second: 9, clean: true, conflicts: [], first_ancestor_second: false, second_ancestor_first: false },
      ],
    };
    const order = recommendMergeOrder(rows, indexProbes([{ repo: "/repo", probe }]));
    expect(order.map((step) => step.row.number)).toEqual([5, 9, 3]);
    expect(order.find((step) => step.row.number === 3)?.stackAfter?.number).toBe(9);
  });

  it("names an unavoidable conflict on the later step", () => {
    const rows = [row({ number: 2 }), row({ number: 4, head_sha: sha("4") })];
    const probe: ipc.PrMergePlanProbe = {
      repo: "/repo",
      unavailable: [],
      fetch_error: null,
      pairs: [{ first: 2, second: 4, clean: false, conflicts: ["src/a.ts"], first_ancestor_second: false, second_ancestor_first: false }],
    };
    const order = recommendMergeOrder(rows, indexProbes([{ repo: "/repo", probe }]));
    expect(order.map((step) => step.row.number)).toEqual([2, 4]);
    expect(order[1].conflictsWith).toEqual([2]);
  });
});

describe("dashboard labels", () => {
  it("formats age without a timer and selects the newest provenance edge", () => {
    expect(openAge("2026-08-01T00:00:00Z", Date.parse("2026-08-09T00:00:00Z"))).toBe("8d open");
    expect(sessionLabel([
      { repo: "/repo", pr_number: 1, pr_url: "", branch: "x", session_id: "oldsession", cwd: "/repo", via: "pr_watch", at: 1, confidence: "observed" },
      { repo: "/repo", pr_number: 1, pr_url: "", branch: "x", session_id: "newsession", agent: "codex", cwd: "/repo", via: "job_done", at: 2, confidence: "declared" },
    ])).toBe("codex · newsessi");
  });
});

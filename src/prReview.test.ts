import { describe, expect, it } from "vitest";
import {
  actionable,
  fileNote,
  isNit,
  isTrusted,
  nextMove,
  parseSuggestions,
  roleFor,
  threadSuggestion,
  threadsByPath,
  verdicts,
} from "./prReview";
import type * as ipc from "./ipc";

const comment = (over: Partial<ipc.PrComment> = {}): ipc.PrComment => ({
  id: "C_1",
  author: "alice",
  body: "this leaks on unmount",
  created: "2026-07-01T10:00:00Z",
  url: "https://github.com/o/r/pull/1#c1",
  mine: false,
  association: "COLLABORATOR",
  ...over,
});

const thread = (over: Partial<ipc.PrThread> = {}): ipc.PrThread => ({
  id: "T_1",
  path: "src/a.ts",
  line: 12,
  start_line: 0,
  side: "RIGHT",
  resolved: false,
  outdated: false,
  comments: [comment()],
  ...over,
});

const review = (over: Partial<ipc.PrReviewSummary> = {}): ipc.PrReviewSummary => ({
  ...comment(),
  id: "R_1",
  state: "CHANGES_REQUESTED",
  submitted: "2026-07-01T11:00:00Z",
  commit: "aaa",
  ...over,
});

const conv = (over: Partial<ipc.PrConversation> = {}): ipc.PrConversation => ({
  node_id: "PR_1",
  body: "",
  head_sha: "head",
  viewer: "me",
  review_decision: "",
  mergeable: "MERGEABLE",
  checks: "PASS",
  auto_merge: false,
  draft: false,
  comments: [],
  reviews: [],
  threads: [],
  files: [],
  my_last_review_sha: "",
  ...over,
});

const pr = (over: Partial<ipc.PrInfo> = {}): ipc.PrInfo => ({
  number: 1,
  title: "Tighten the parser",
  author: "me",
  branch: "fix/parser",
  base: "main",
  draft: false,
  state: "OPEN",
  url: "https://github.com/o/r/pull/1",
  created: "2026-07-01T09:00:00Z",
  updated: "2026-07-01T09:00:00Z",
  review_decision: "",
  additions: 10,
  deletions: 2,
  mine: true,
  mergeable: "MERGEABLE",
  checks: "PASS",
  checks_summary: "4/4 checks passed",
  ...over,
});

describe("trust boundary", () => {
  it("only trusts people with write access to the repo", () => {
    expect(isTrusted("OWNER")).toBe(true);
    expect(isTrusted("MEMBER")).toBe(true);
    expect(isTrusted("COLLABORATOR")).toBe(true);
    // A comment is fed to an agent that can push. A drive-by "CONTRIBUTOR" or
    // "NONE" comment is read by the human and nobody else.
    expect(isTrusted("CONTRIBUTOR")).toBe(false);
    expect(isTrusted("NONE")).toBe(false);
    expect(isTrusted("")).toBe(false);
  });

  it("does not count an untrusted comment as work to do", () => {
    const a = actionable(
      conv({
        comments: [comment({ association: "NONE" })],
        threads: [thread({ comments: [comment({ id: "C_9", association: "NONE" })] })],
      }),
    );
    expect(a.count).toBe(0);
  });
});

describe("actionable", () => {
  it("counts unresolved threads, other people's comments and change requests", () => {
    const a = actionable(
      conv({
        threads: [thread(), thread({ id: "T_2", resolved: true })],
        comments: [comment({ id: "C_2" })],
        reviews: [review()],
      }),
    );
    expect(a.count).toBe(3);
    expect(a.ids).toEqual(["T_1", "C_2", "R_1"]);
  });

  it("ignores my own voice — a thread of my replies is not work", () => {
    const a = actionable(
      conv({
        threads: [thread({ comments: [comment({ mine: true })] })],
        comments: [comment({ id: "C_3", mine: true })],
        reviews: [review({ mine: true })],
      }),
    );
    expect(a.count).toBe(0);
  });

  it("keeps an outdated-but-unresolved thread — the code moved, the point may stand", () => {
    expect(actionable(conv({ threads: [thread({ outdated: true })] })).count).toBe(1);
  });
});

describe("threadsByPath", () => {
  it("groups by file and orders by line", () => {
    const map = threadsByPath([
      thread({ id: "T_b", line: 30 }),
      thread({ id: "T_a", line: 4 }),
      thread({ id: "T_c", path: "src/b.ts", line: 7 }),
    ]);
    expect(map.get("src/a.ts")?.map((t) => t.id)).toEqual(["T_a", "T_b"]);
    expect(map.get("src/b.ts")?.map((t) => t.id)).toEqual(["T_c"]);
  });
});

describe("suggested changes", () => {
  it("reads the replacement text out of a suggestion fence", () => {
    expect(parseSuggestions("Try:\n```suggestion\nconst x = 1;\n```\nthanks")).toEqual([
      "const x = 1;",
    ]);
  });

  it("handles several fences and keeps inner indentation", () => {
    const body = "```suggestion\n  a\n```\ntext\n````suggestion js\nb\n````";
    expect(parseSuggestions(body)).toEqual(["  a", "b"]);
  });

  it("finds nothing in a plain comment", () => {
    expect(parseSuggestions("just a thought")).toEqual([]);
    expect(threadSuggestion(thread())).toBeNull();
  });

  it("picks the first suggestion in a thread", () => {
    const t = thread({
      comments: [comment({ body: "no code" }), comment({ id: "C_2", body: "```suggestion\nx\n```" })],
    });
    expect(threadSuggestion(t)).toBe("x");
  });
});

describe("nits", () => {
  it("recognises the convention the review brief asks for", () => {
    expect(isNit("Nit: rename this")).toBe(true);
    expect(isNit("nitpick - spacing")).toBe(true);
    expect(isNit("This is not a nit")).toBe(false);
  });
});

describe("roleFor", () => {
  it("uses the signed-in login when the conversation has loaded", () => {
    expect(roleFor(pr({ author: "me" }), conv({ viewer: "me" }))).toBe("author");
    expect(roleFor(pr({ author: "alice" }), conv({ viewer: "me" }))).toBe("reviewer");
  });

  it("falls back to gh's own `mine` before the conversation arrives", () => {
    expect(roleFor(pr({ mine: true }), null)).toBe("author");
    expect(roleFor(pr({ mine: false }), null)).toBe("reviewer");
  });
});

describe("nextMove", () => {
  it("puts a broken build ahead of unanswered comments", () => {
    const m = nextMove(pr(), conv({ checks: "FAIL", threads: [thread()] }), { actionable: 1 });
    expect(m.id).toBe("fix-ci");
    expect(m.urgent).toBe(true);
  });

  it("puts conflicts ahead of everything — nothing can land", () => {
    const m = nextMove(pr(), conv({ mergeable: "CONFLICTING", checks: "FAIL" }), { actionable: 3 });
    expect(m.id).toBe("update-branch");
  });

  it("asks the author to self-review a draft before anyone else looks", () => {
    expect(nextMove(pr({ draft: true }), conv({ draft: true }), { actionable: 0 }).id).toBe(
      "self-review",
    );
  });

  it("names the comment count for the author", () => {
    const m = nextMove(pr(), conv({ threads: [thread()] }), { actionable: 2 });
    expect(m.id).toBe("address-comments");
    expect(m.label).toContain("2 comments");
  });

  it("asks a reviewer who hasn't reviewed to review", () => {
    const m = nextMove(pr({ author: "alice", mine: false }), conv({ viewer: "me" }), {
      actionable: 0,
    });
    expect(m.id).toBe("review-it");
  });

  it("offers the delta when a reviewer's review is behind head", () => {
    const m = nextMove(
      pr({ author: "alice", mine: false }),
      conv({ viewer: "me", my_last_review_sha: "old", head_sha: "new" }),
      { actionable: 0 },
    );
    expect(m.action).toBe("Review the delta");
  });

  it("states the ready-to-land case without an action — Merge ▾ owns merging", () => {
    // A second Merge button here only opened the header's menu, which is where
    // the method is chosen; the banner is the status, not the deed.
    const m = nextMove(pr(), conv({ review_decision: "APPROVED" }), { actionable: 0 });
    expect(m.id).toBe("merge");
    expect(m.action).toBeUndefined();
  });

  it("only offers merge when GitHub says approved, green and mergeable", () => {
    expect(nextMove(pr(), conv({ review_decision: "APPROVED" }), { actionable: 0 }).id).toBe("merge");
    expect(
      nextMove(pr(), conv({ review_decision: "APPROVED", checks: "FAIL" }), { actionable: 0 }).id,
    ).toBe("fix-ci");
  });

  it("says nothing needs doing while a round is running", () => {
    const m = nextMove(pr(), conv({ threads: [thread()] }), { actionable: 1, loopBusy: true });
    expect(m.id).toBe("none");
    expect(m.action).toBeUndefined();
  });

  it("stops offering anything once the PR has landed", () => {
    expect(nextMove(pr({ state: "MERGED" }), conv(), { actionable: 0 }).id).toBe("landed");
  });
});

describe("verdicts", () => {
  it("shows real verdicts newest first and drops empty comment-only reviews", () => {
    const list = verdicts(
      conv({
        reviews: [
          review({ id: "R_old", state: "COMMENTED", body: "looks fine", submitted: "2026-07-01T10:00:00Z" }),
          review({ id: "R_new", state: "APPROVED", body: "", submitted: "2026-07-02T10:00:00Z" }),
          review({ id: "R_empty", state: "COMMENTED", body: "  ", submitted: "2026-07-03T10:00:00Z" }),
          review({ id: "R_pending", state: "PENDING", body: "wip", submitted: "" }),
        ],
      }),
    );
    expect(list.map((r) => r.id)).toEqual(["R_new", "R_old"]);
  });
});

describe("fileNote", () => {
  it("reads the reason a reassembled patch couldn't inline a file", () => {
    const patch =
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n" +
      "Binary files a/pnpm-lock.yaml and b/pnpm-lock.yaml differ\n" +
      "(GitHub didn't include this file's patch — 4211 changed lines. Open it on GitHub.)\n";
    expect(fileNote(patch)).toBe(
      "GitHub didn't include this file's patch — 4211 changed lines. Open it on GitHub.",
    );
  });

  it("reads the truncation notice", () => {
    expect(fileNote("(12 more file(s) not shown — this pull request touches more than 400.)")).toBe(
      "12 more file(s) not shown — this pull request touches more than 400.",
    );
  });

  it("says nothing for a real binary or a normal patch", () => {
    expect(fileNote("Binary files a/logo.png and b/logo.png differ")).toBeNull();
    expect(fileNote("@@ -1,2 +1,3 @@\n+const x = 1;")).toBeNull();
  });
});

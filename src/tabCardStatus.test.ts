import { describe, expect, it } from "vitest";
import { cardStatus } from "./tabCardStatus";
import type { SubTab } from "./components/ProjectView/helpers";

const term = (extra: Partial<Extract<SubTab, { type: "terminal" }>> = {}): SubTab => ({
  id: "t1",
  type: "terminal",
  cwd: "/w",
  title: "t1",
  ptyId: 1,
  command: "claude",
  ...extra,
});

const prTab = (pr: Partial<Record<string, unknown>>): SubTab =>
  ({
    id: "p1",
    type: "pr",
    repo: "/r",
    pr: {
      number: 1,
      state: "OPEN",
      draft: false,
      checks: "",
      review_decision: "",
      mergeable: "UNKNOWN",
      ...pr,
    },
  }) as never;

describe("cardStatus", () => {
  it("carries the agent bucket and its label", () => {
    expect(cardStatus(term(), "active")).toEqual({ bucket: "active", line: "Working" });
    expect(cardStatus(term(), "quiet")).toEqual({ bucket: "quiet", line: "Idle" });
  });

  it("surfaces an unread notice on an attention session", () => {
    const s = cardStatus(term({ unread: true, notice: "Needs a decision" }), "attention");
    expect(s).toEqual({ bucket: "attention", line: "Needs a decision" });
  });

  it("says nothing for a tab with no bucket and no state of its own", () => {
    expect(cardStatus(term())).toEqual({ bucket: null, line: "" });
    expect(cardStatus({ id: "n", type: "note", noteId: "n", title: "n" })).toEqual({
      bucket: null,
      line: "",
    });
  });

  it("marks a PR that needs the user", () => {
    expect(cardStatus(prTab({ checks: "FAIL" }))).toEqual({
      bucket: "attention",
      line: "CI failing",
    });
    expect(cardStatus(prTab({ review_decision: "CHANGES_REQUESTED" }))).toEqual({
      bucket: "attention",
      line: "changes requested",
    });
    expect(cardStatus(prTab({ mergeable: "CONFLICTING" }))).toEqual({
      bucket: "attention",
      line: "conflicts",
    });
  });

  it("composes the line most-urgent-first", () => {
    const s = cardStatus(
      prTab({ draft: true, checks: "FAIL", review_decision: "CHANGES_REQUESTED" }),
    );
    expect(s.line).toBe("Draft · CI failing · changes requested");
  });

  it("running CI is active, green-and-approved is calm", () => {
    expect(cardStatus(prTab({ checks: "PENDING" }))).toEqual({
      bucket: "active",
      line: "CI running",
    });
    expect(cardStatus(prTab({ checks: "PASS", review_decision: "APPROVED" }))).toEqual({
      bucket: null,
      line: "CI passing · approved",
    });
  });

  it("merged and closed PRs say only that", () => {
    expect(cardStatus(prTab({ state: "MERGED", checks: "PASS" }))).toEqual({
      bucket: null,
      line: "Merged",
    });
    expect(cardStatus(prTab({ state: "closed" }))).toEqual({ bucket: null, line: "Closed" });
  });

  it("unread chat needs you", () => {
    const chat: SubTab = { id: "c", type: "chat", peer: null, name: "everyone", unread: true };
    expect(cardStatus(chat)).toEqual({ bucket: "attention", line: "Unread" });
  });
});

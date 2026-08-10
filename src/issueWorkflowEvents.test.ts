import { describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import { diffIssueWorkflowEvents, issueWorkflowEvent } from "./issueWorkflowEvents";

const ticket = (overrides: Partial<ipc.TicketInfo> = {}): ipc.TicketInfo => ({
  id: "#42",
  title: "Workflow issues",
  state: "open",
  state_type: "open",
  assignee: null,
  mine: false,
  url: "https://github.com/acme/app/issues/42",
  branch: null,
  body: "Treat issues as events.",
  priority: "",
  updated_at: "2026-08-10T01:00:00Z",
  ...overrides,
});

describe("issue workflow events", () => {
  it("preserves provider provenance and comment bodies", () => {
    expect(issueWorkflowEvent(
      "issue.comment",
      { source: "github", repo: "/repo", ticket: ticket() },
      { body: "@canopy run this" },
      "event-1",
      123,
    )).toEqual({
      kind: "issue.comment",
      eventId: "event-1",
      occurredAt: 123,
      payload: expect.objectContaining({
        source: "github",
        repo: "/repo",
        issueId: "#42",
        body: "@canopy run this",
      }),
    });
  });

  it("detects opened, updated, closed, and reopened issues", () => {
    const previous = [
      ticket(),
      ticket({ id: "#43", updated_at: "1" }),
      ticket({ id: "#44", state: "closed", state_type: "closed" }),
    ];
    const current = [
      ticket({ updated_at: "2026-08-10T02:00:00Z" }),
      ticket({ id: "#43", state: "closed", state_type: "closed", updated_at: "2" }),
      ticket({ id: "#44", state: "open", state_type: "open", updated_at: "2" }),
      ticket({ id: "#45" }),
    ];
    expect(diffIssueWorkflowEvents(previous, current, "github", "/repo", 456)
      .map((event) => [event.payload.issueId, event.kind])).toEqual([
        ["#42", "issue.updated"],
        ["#43", "issue.closed"],
        ["#44", "issue.reopened"],
        ["#45", "issue.opened"],
      ]);
  });

  it("treats a disappearing active Linear issue as an inferred close", () => {
    const [event] = diffIssueWorkflowEvents(
      [ticket({ id: "ENG-12", state: "In Progress", state_type: "started" })],
      [],
      "linear",
      "/repo",
      789,
    );
    expect(event).toMatchObject({
      kind: "issue.closed",
      occurredAt: 789,
      payload: { issueId: "ENG-12", inferred: true, stateType: "closed" },
    });
  });
});

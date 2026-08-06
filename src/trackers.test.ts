import { describe, expect, it } from "vitest";
import { ticketResearchQuestion } from "./trackers";
import type * as ipc from "./ipc";

const ticket: ipc.TicketInfo = {
  id: "#42",
  title: "Should we do X?",
  state: "open",
  state_type: "open",
  assignee: null,
  mine: false,
  url: "https://github.com/acme/app/issues/42",
  branch: null,
  body: "The actual question lives in the body.",
  priority: "",
};

describe("ticketResearchQuestion", () => {
  it("carries id, title, url and the body — the body is the question", () => {
    const q = ticketResearchQuestion(ticket);
    expect(q).toContain("#42");
    expect(q).toContain("Should we do X?");
    expect(q).toContain(ticket.url);
    expect(q).toContain("The actual question lives in the body.");
  });

  it("truncates a long body instead of shipping all of it", () => {
    const q = ticketResearchQuestion({ ...ticket, body: "x".repeat(5000) });
    expect(q.length).toBeLessThan(2500);
    expect(q).toContain("…");
  });

  it("copes with an empty body", () => {
    const q = ticketResearchQuestion({ ...ticket, body: "  " });
    expect(q).toContain("#42");
    expect(q).not.toContain("The ticket says");
  });
});

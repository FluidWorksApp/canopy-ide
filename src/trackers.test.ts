import { describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { TRACKERS, ticketResearchQuestion, trackerIoSnapshot } from "./trackers";

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

describe("tracker request ownership", () => {
  it("shares one in-flight repository request and releases it at settlement", async () => {
    let release!: (rows: ipc.TicketInfo[]) => void;
    const load = vi.spyOn(ipc, "ghIssueList").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const github = TRACKERS.find((provider) => provider.id === "github")!;
    const first = github.fetch("/repo");
    const second = github.fetch("/repo");
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(trackerIoSnapshot().activeFetches).toBe(1);
    release([]);
    await first;
    expect(trackerIoSnapshot().activeFetches).toBe(0);
    load.mockResolvedValue([]);
    await github.fetch("/repo");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

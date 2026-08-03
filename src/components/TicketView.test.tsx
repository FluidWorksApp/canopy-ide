import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockCommands } from "../test/setup";
import { TicketView } from "./TicketView";

const ticket = {
  id: "#42",
  title: "Show issue details",
  state: "open",
  state_type: "open",
  assignee: null,
  mine: false,
  url: "https://github.com/acme/app/issues/42",
  branch: null,
  body: "Issue description",
  priority: "",
};

const detail = {
  author: "octocat",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-02T11:00:00Z",
  state: "open",
  comments: [{
    id: "c1",
    author: "reviewer",
    body: "Please ship this.",
    created_at: "2026-08-02T11:00:00Z",
    url: "https://github.com/acme/app/issues/42#issuecomment-1",
  }],
};

const view = (commands: Record<string, unknown> = {}) => {
  mockCommands({ gh_issue_detail: detail, ...commands });
  return render(
    <TicketView
      ticket={ticket}
      source="github"
      repo="/work/app"
      worktree={undefined}
      agentTargets={[]}
      installed={{}}
      onStartNew={vi.fn()}
      onSendToAgent={vi.fn()}
    />,
  );
};

describe("TicketView", () => {
  it("shows GitHub issue provenance and conversation", async () => {
    view();
    expect(await screen.findByText("opened by octocat")).toBeInTheDocument();
    expect(screen.getByText("Please ship this.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close issue" })).toBeInTheDocument();
  });

  it("closes an issue and posts a comment", async () => {
    const setState = vi.fn();
    const post = vi.fn();
    view({ gh_issue_set_state: setState, gh_issue_comment: post });
    await screen.findByText("opened by octocat");

    await userEvent.click(screen.getByRole("button", { name: "Close issue" }));
    await waitFor(() => expect(setState).toHaveBeenCalledWith({
      repo: "/work/app",
      number: 42,
      open: false,
    }));

    await userEvent.type(screen.getByPlaceholderText("Add a comment"), "Looks good");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith({
      repo: "/work/app",
      number: 42,
      body: "Looks good",
    }));
  });
});

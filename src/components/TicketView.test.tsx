import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../settings";
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
  internal_id: "",
  author: "octocat",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-02T11:00:00Z",
  state: "open",
  state_id: "",
  states: [],
  comments: [{
    id: "c1",
    author: "reviewer",
    body: "Please ship this.",
    created_at: "2026-08-02T11:00:00Z",
    url: "https://github.com/acme/app/issues/42#issuecomment-1",
  }],
};

const view = (commands: Record<string, unknown> = {}, onResearch = vi.fn()) => {
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
      onStartTask={vi.fn()}
      onResearch={onResearch}
      onSendToAgent={vi.fn()}
    />,
  );
};

describe("TicketView", () => {
  beforeEach(() => localStorage.clear());

  it("shows GitHub issue provenance and conversation", async () => {
    view();
    expect(await screen.findByText("opened by octocat")).toBeInTheDocument();
    expect(screen.getByText("Please ship this.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close issue" })).toBeInTheDocument();
  });

  it("forwards the ticket to research", async () => {
    const onResearch = vi.fn();
    view({}, onResearch);
    await userEvent.click(screen.getByRole("button", { name: "Research this" }));
    expect(onResearch).toHaveBeenCalledTimes(1);
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

  it("walks the start-work button through starting and running", async () => {
    let release!: () => void;
    const start = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const showTasks = vi.fn();
    mockCommands({ gh_issue_detail: detail });
    const props = {
      ticket,
      source: "github",
      repo: "/work/app",
      worktree: undefined,
      agentTargets: [],
      installed: {},
      onStartNew: vi.fn(),
      onStartTask: start,
      onShowTasks: showTasks,
      onResearch: vi.fn(),
      onSendToAgent: vi.fn(),
    };
    const { rerender } = render(<TicketView {...props} />);
    await screen.findByText("opened by octocat");

    await userEvent.click(screen.getByTitle("Start this ticket as a one-shot task"));
    expect(start).toHaveBeenCalledTimes(1);
    // Mid-submit the button says so and cannot fire a second copy.
    expect(screen.getByText("Starting…").closest("button")).toBeDisabled();

    release();
    rerender(<TicketView {...props} taskRunning />);
    // Once the run is live, the primary click shows it in Tasks instead of
    // launching again.
    await userEvent.click(
      await screen.findByTitle("This is running as a task — click to watch it in Tasks"),
    );
    expect(showTasks).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("loads Linear details and changes its workflow state", async () => {
    updateSettings({ trackerKeys: { linear: "lin_test" } });
    const linearDetail = {
      ...detail,
      internal_id: "issue-uuid",
      author: "Alicia",
      state: "In Progress",
      state_id: "started-id",
      states: [
        { id: "todo-id", name: "Todo" },
        { id: "started-id", name: "In Progress" },
        { id: "done-id", name: "Done" },
      ],
    };
    const setState = vi.fn();
    const post = vi.fn();
    mockCommands({
      linear_issue_detail: linearDetail,
      linear_issue_set_state: setState,
      linear_issue_comment: post,
    });
    render(
      <TicketView
        ticket={{ ...ticket, id: "ENG-123", state: "In Progress", state_type: "started" }}
        source="linear"
        repo="/work/app"
        worktree={undefined}
        agentTargets={[]}
        installed={{}}
        onStartNew={vi.fn()}
        onStartTask={vi.fn()}
        onResearch={vi.fn()}
        onSendToAgent={vi.fn()}
      />,
    );

    expect(await screen.findByText("opened by Alicia")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Issue status" }), "done-id");
    await waitFor(() => expect(setState).toHaveBeenCalledWith({
      apiKey: "lin_test",
      issueId: "issue-uuid",
      stateId: "done-id",
    }));

    await userEvent.type(screen.getByPlaceholderText("Add a comment"), "Linear reply");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith({
      apiKey: "lin_test",
      issueId: "issue-uuid",
      body: "Linear reply",
    }));
  });
});

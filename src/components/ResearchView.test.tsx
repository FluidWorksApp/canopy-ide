import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResearchView } from "./ResearchView";
import { ResearchPanel } from "./ResearchPanel";
import { mockCommands } from "../test/setup";
import type * as ipc from "../ipc";

const detail = (over: Partial<ipc.ResearchDetail> = {}): ipc.ResearchDetail => ({
  id: "0007-index-staleness",
  title: "Index staleness",
  status: "researched",
  digest: "Ingest only runs when the palette opens, so the index lags.",
  tags: ["spotsearch"],
  agent: "claude",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_500,
  source_count: 1,
  pr_count: 0,
  superseded_by: null,
  question: "Why does the index go stale?",
  recommendation: "Ingest on write as well.",
  open_questions: ["Does that slow the palette?"],
  body: "## What I read\n\nThe ingest path in spot.rs.",
  sources: [
    {
      file: "sources/01-spot-rs.md",
      title: "spot.rs ingest path",
      origin: "file:/repo/src-tauri/src/spot.rs",
      bytes: 4096,
    },
  ],
  links: {
    tickets: [],
    prs: [],
    branches: [],
    files: [],
    supersedes: [],
    superseded_by: null,
  },
  history: [
    { at: 1_700_000_000, from: "open", to: "researching", by: "", note: "started" },
  ],
  dir: "/home/dev/.canopy/research/p1/0007-index-staleness",
  ...over,
});

const summary = (over: Partial<ipc.ResearchSummary> = {}): ipc.ResearchSummary => ({
  id: "0007-index-staleness",
  title: "Index staleness",
  status: "researched",
  digest: "Ingest only runs when the palette opens, so the index lags.",
  tags: [],
  agent: "claude",
  created_at: 0,
  updated_at: 1_700_000_500,
  source_count: 1,
  pr_count: 0,
  superseded_by: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ResearchView", () => {
  it("leads with the finding and the recommendation", async () => {
    mockCommands({ research_get: () => detail() });
    render(<ResearchView projectId="p1" researchId="0007-index-staleness" />);

    // The two capped fields are the entry; the write-up is the working.
    expect(await screen.findByText(/Ingest only runs when the palette opens/))
      .toBeInTheDocument();
    expect(screen.getByText("Ingest on write as well.")).toBeInTheDocument();
    expect(screen.getByText("Researched")).toBeInTheDocument();
    expect(screen.getByText(/Does that slow the palette\?/)).toBeInTheDocument();
    expect(screen.getByText(/The ingest path in spot\.rs\./)).toBeInTheDocument();
  });

  it("names a source without pouring it into the page", async () => {
    const read = vi.fn(() => "line one\nline two");
    mockCommands({ research_get: () => detail(), research_read_file: read });
    render(<ResearchView projectId="p1" researchId="0007-index-staleness" />);

    // Listed, and its contents not fetched — this is the tier rule as the
    // reader experiences it.
    const toggle = await screen.findByRole("button", { name: /spot\.rs ingest path/ });
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByText(/line one/)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/line one/)).toBeInTheDocument());
    expect(read).toHaveBeenCalledOnce();
  });

  it("offers Implement only when the state machine allows it", async () => {
    mockCommands({ research_get: () => detail() });
    const onImplement = vi.fn();
    const { unmount } = render(
      <ResearchView
        projectId="p1"
        researchId="0007-index-staleness"
        onImplement={onImplement}
      />,
    );
    expect(await screen.findByRole("button", { name: "Implement this" }))
      .toBeInTheDocument();
    unmount();

    // Still being researched: there is no finding to build yet, so the button
    // is absent rather than present-and-failing.
    mockCommands({ research_get: () => detail({ status: "researching" }) });
    render(
      <ResearchView
        projectId="p1"
        researchId="0007-index-staleness"
        onImplement={onImplement}
      />,
    );
    // The status pill, specifically — the progress rail names the agent, not
    // the status, so there is exactly one "Researching" on the page.
    expect(await screen.findByText("Researching")).toHaveClass(
      "research-status-researching",
    );
    expect(screen.queryByRole("button", { name: "Implement this" })).toBeNull();
  });

  it("warns before it is read when a later entry replaced it", async () => {
    mockCommands({
      research_get: () => detail({ status: "superseded", superseded_by: "0009-better" }),
    });
    render(<ResearchView projectId="p1" researchId="0007-index-staleness" />);
    // Acting on a replaced finding is the failure this prevents, so the notice
    // sits above the content rather than in the history at the bottom.
    expect(await screen.findByText(/Superseded by 0009-better/)).toBeInTheDocument();
  });

  it("shows the stage rail while a run is live, and nothing once it is not", async () => {
    // The complaint this answers: an entry sat completely still for however
    // long the research took.
    mockCommands({
      research_get: () => detail({ status: "researching", body: "# Title\n\n" }),
      research_read_file: () => "orient\nsearch\n",
    });
    const { unmount } = render(
      <ResearchView projectId="p1" researchId="0007-index-staleness" />,
    );
    // Reported milestones read as done, in the past tense.
    expect(await screen.findByText("Got its bearings")).toBeInTheDocument();
    expect(screen.getByText("Checked what's known")).toBeInTheDocument();
    // The first unreported one is what it is doing now.
    expect(screen.getByText("Digging into it")).toBeInTheDocument();
    // And an empty write-up says so rather than looking broken.
    expect(screen.getByText(/findings appear here/)).toBeInTheDocument();
    unmount();

    // A finished entry gets no rail — a progress bar on something that ended
    // is the same lie the spinner told.
    mockCommands({ research_get: () => detail({ status: "researched" }) });
    render(<ResearchView projectId="p1" researchId="0007-index-staleness" />);
    await screen.findByText("Researched");
    expect(screen.queryByText("Digging into it")).toBeNull();
  });

  it("says so rather than rendering blank when the entry is gone", async () => {
    mockCommands({
      research_get: () => {
        throw new Error("no research entry there");
      },
    });
    render(<ResearchView projectId="p1" researchId="0007-gone" />);
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
  });
});

describe("ResearchPanel", () => {
  it("groups by status and carries the digest on the row", async () => {
    mockCommands({
      research_list: () => [
        summary(),
        summary({
          id: "0008-other",
          title: "Other thing",
          status: "implementing",
          digest: "Something else entirely.",
        }),
      ],
    });
    render(
      <ResearchPanel projectId="p1" onOpen={vi.fn()} onStart={vi.fn()} canStart />,
    );

    expect(await screen.findByText("Researched")).toBeInTheDocument();
    expect(screen.getByText("Implementing")).toBeInTheDocument();
    expect(
      screen.getByText(/Ingest only runs when the palette opens/),
    ).toBeInTheDocument();
  });

  it("sends a typed question off as a research run", async () => {
    mockCommands({ research_list: () => [] });
    const onStart = vi.fn();
    render(
      <ResearchPanel projectId="p1" onOpen={vi.fn()} onStart={onStart} canStart />,
    );
    await userEvent.type(
      screen.getByPlaceholderText("Research a question…"),
      "why is startup slow{Enter}",
    );
    expect(onStart).toHaveBeenCalledWith("why is startup slow");
  });

  it("explains itself when there is nothing yet", async () => {
    mockCommands({ research_list: () => [] });
    render(
      <ResearchPanel projectId="p1" onOpen={vi.fn()} onStart={vi.fn()} canStart />,
    );
    // An empty panel that only says "nothing here" teaches nobody what the
    // panel is for.
    expect(await screen.findByText(/instead of in a file that disappears/))
      .toBeInTheDocument();
  });

  it("cannot start a run with no agent installed", async () => {
    mockCommands({ research_list: () => [] });
    const onStart = vi.fn();
    render(
      <ResearchPanel
        projectId="p1"
        onOpen={vi.fn()}
        onStart={onStart}
        canStart={false}
      />,
    );
    await userEvent.type(
      screen.getByPlaceholderText("Research a question…"),
      "anything{Enter}",
    );
    expect(onStart).not.toHaveBeenCalled();
  });
});

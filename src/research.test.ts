import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import {
  settleIfRunning,
  ACTIVE_STATUSES,
  NEXT_STATUSES,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_ORDER,
  STATUS_STEP,
  forget,
  implementContext,
  reconcileMerged,
  refresh,
  researchContext,
  resetStoreWatchForTest,
  watchStore,
} from "./research";
import { __reset as resetPrLinkState } from "./prLinkState";

const STATUSES = STATUS_ORDER;

describe("the status model", () => {
  it("names and explains every status it can render", () => {
    // A status the panel can group by but not label renders as a blank
    // heading, which is worse than not grouping at all.
    for (const s of STATUSES) {
      expect(STATUS_LABELS[s], s).toBeTruthy();
      expect(STATUS_BLURBS[s], s).toBeTruthy();
      expect(STATUS_STEP[s], s).toBeTypeOf("number");
    }
  });

  it("puts what needs a human before what is merely finished", () => {
    // The panel renders in this order, so it is the order the eye gets. What
    // is stuck comes first; what has been put down comes last.
    expect(STATUS_ORDER[0]).toBe("blocked");
    expect(STATUS_ORDER.indexOf("researched")).toBeLessThan(
      STATUS_ORDER.indexOf("implemented"),
    );
    expect(STATUS_ORDER.at(-1)).toBe("archived");
  });

  it("keeps the closed record out of the default worklist", () => {
    expect(ACTIVE_STATUSES).not.toContain("archived");
    expect(ACTIVE_STATUSES).not.toContain("superseded");
    // But not "implemented": what shipped from research is the question
    // nothing else in the IDE could answer, so it stays on the list.
    expect(ACTIVE_STATUSES).toContain("implemented");
    expect(ACTIVE_STATUSES).toContain("researched");
  });

  it("treats blocked as an interruption, not a stage of its own", () => {
    // It keeps the rank of the work it interrupted — an entry that gets stuck
    // has not travelled backwards.
    expect(STATUS_STEP.blocked).toBe(STATUS_STEP.researching);
  });
});

// This is the test that matters most in this file. NEXT_STATUSES exists so the
// detail view offers only moves the store will accept; the store's own machine
// is in src-tauri/src/research.rs and is the authority. If someone changes one
// side, this is what says so — the alternative is a button that fails when
// pressed, which teaches users the UI lies.
describe("the transition table mirrored from the Rust state machine", () => {
  const rustNext: Record<string, string[]> = {
    open: ["researching", "archived"],
    researching: ["researched", "blocked", "archived"],
    blocked: ["researching", "researched", "implementing", "archived"],
    researched: ["implementing", "researching", "blocked", "superseded", "archived"],
    implementing: ["implemented", "researched", "blocked", "archived"],
    implemented: ["superseded", "archived"],
    superseded: ["archived"],
    archived: [],
  };

  it("matches research.rs exactly", () => {
    for (const s of STATUSES) {
      expect(NEXT_STATUSES[s], `${s} — update both sides or neither`).toEqual(
        rustNext[s],
      );
    }
  });

  it("refuses the shortcut the whole machine exists to prevent", () => {
    // Nothing may claim it shipped without having been researched first.
    expect(NEXT_STATUSES.open).not.toContain("implemented");
    expect(NEXT_STATUSES.researching).not.toContain("implementing");
    expect(NEXT_STATUSES.researched).toContain("implementing");
  });

  it("lets anything be put down, and nothing come back out", () => {
    for (const s of STATUSES) {
      if (s !== "archived") expect(NEXT_STATUSES[s], s).toContain("archived");
    }
    expect(NEXT_STATUSES.archived).toEqual([]);
  });
});

const entry = (over: Partial<ipc.ResearchDetail> = {}): ipc.ResearchDetail => ({
  id: "0007-index-staleness",
  title: "Index staleness",
  status: "researched",
  digest: "The index lags because ingest only runs on palette open.",
  tags: [],
  agent: "claude",
  created_at: 0,
  updated_at: 0,
  source_count: 2,
  pr_count: 0,
  superseded_by: null,
  question: "Why does the index go stale?",
  recommendation: "Ingest on write as well as on open.",
  open_questions: ["Does that make the palette slower?"],
  body: "x".repeat(20_000),
  sources: [],
  links: {
    tickets: [],
    prs: [],
    branches: [],
    files: [],
    supersedes: [],
    superseded_by: null,
  },
  history: [],
  dir: "/home/dev/.canopy/research/p1/0007-index-staleness",
  ...over,
});

describe("the handoff to an implementing agent", () => {
  it("carries the finding, not the document", () => {
    const ctx = implementContext(entry());
    expect(ctx).toContain("The index lags because ingest only runs");
    expect(ctx).toContain("Ingest on write as well as on open.");
    // The point of capping the digest was that this handoff could be one
    // paragraph. Pasting the body here would spend the budget the tiers exist
    // to protect — the agent can fetch it if it wants it.
    expect(ctx).not.toContain("x".repeat(200));
    expect(ctx.length).toBeLessThan(1200);
    expect(ctx).toContain("canopy_research get");
  });

  it("makes linking the PR non-optional, because the loop closes on it", () => {
    const ctx = implementContext(entry());
    expect(ctx).toContain("canopy_research_write");
    expect(ctx).toContain("link");
  });

  it("says what to do when no PR will ever close it", () => {
    // reconcileMerged only ever moves an entry that has a linked PR. Work that
    // landed in a commit, was already done, or turned out not to be worth
    // doing leaves the entry in "implementing" forever — and the agent that
    // found that out is the only one who knows. The same gap left a scratchpad
    // note sitting "In progress" after its fix had shipped.
    const ctx = implementContext(entry());
    expect(ctx).toContain("append");
    expect(ctx).toContain("status");
    expect(ctx).toContain("researched");
  });

  it("never invites the agent to declare the work implemented", () => {
    // "implemented" is the module's one piece of evidence rather than
    // assertion: Canopy writes it when every linked PR has merged. A brief that
    // asked the agent for it would turn the status back into an opinion.
    const ctx = implementContext(entry());
    expect(ctx).toMatch(/Never set "implemented" yourself/);
    expect(ctx).not.toMatch(/status.{0,40}"implemented"/);
  });

  it("survives an entry that was never digested", () => {
    // An agent died mid-run; the entry has a title and nothing else. The
    // handoff should still say something rather than render "undefined".
    const ctx = implementContext(
      entry({ digest: "", recommendation: "", open_questions: [] }),
    );
    expect(ctx).toContain("0007-index-staleness");
    expect(ctx).not.toContain("undefined");
  });
});

describe("the brief a research run opens with", () => {
  const summary: ipc.ResearchSummary = {
    id: "0003-thing",
    title: "A thing",
    status: "researching",
    digest: "",
    tags: [],
    agent: "",
    created_at: 0,
    updated_at: 0,
    source_count: 0,
    pr_count: 0,
    superseded_by: null,
  };

  it("names the entry, the tools, and the rule the harness enforces", () => {
    const ctx = researchContext(summary, "why is startup slow?");
    expect(ctx).toContain("0003-thing");
    expect(ctx).toContain("why is startup slow?");
    expect(ctx).toContain("canopy_research_write");
    expect(ctx).toContain("source");
    // Telling the agent the rule up front is what stops it composing a file it
    // then has to redo when the write is refused.
    expect(ctx).toContain("refused");
  });

  it("says the run changes no code", () => {
    const ctx = researchContext(summary, "anything");
    expect(ctx.toLowerCase()).toContain("change none of it");
  });
});


describe("settling a run that ended badly", () => {
  beforeEach(() => vi.restoreAllMocks());

  const entryWith = (status: ipc.ResearchStatus) =>
    vi.spyOn(ipc, "researchGet").mockResolvedValue(entry({ status }));

  it("marks a still-running entry blocked when its run dies unreported", async () => {
    // The bug this fixes: a research entry stayed "researching" forever once
    // its agent stopped, because job_done was the only thing that ever moved
    // it and a dead run never sends one.
    entryWith("researching");
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);
    await settleIfRunning("p1", "0007-x", "blocked", "the run ended without reporting");
    expect(set).toHaveBeenCalledWith(
      "p1",
      "0007-x",
      "blocked",
      "Canopy",
      "the run ended without reporting",
    );
  });

  it("leaves an entry that already reached a conclusion alone", async () => {
    // A process exiting is the last thing that happens either way, so this
    // fires *after* a successful job_done has marked the entry researched.
    // The store would accept researched → blocked quite happily, which is
    // exactly why the guard lives here.
    entryWith("researched");
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);
    await settleIfRunning("p1", "0007-x", "blocked", "the run ended without reporting");
    expect(set).not.toHaveBeenCalled();
  });

  it("says nothing about an entry it cannot read", async () => {
    vi.spyOn(ipc, "researchGet").mockRejectedValue(new Error("gone"));
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);
    await settleIfRunning("p1", "0007-x", "blocked", "n/a");
    expect(set).not.toHaveBeenCalled();
  });
});

// The bug this guards: an agent writing through `canopy_research_write` reaches
// the Rust commands via the MCP endpoint and never touches this module, so the
// window event the mutators below raise cannot fire. The panel fetches once per
// project on mount, so the entry stayed invisible until the project was
// reopened — which looks exactly like the write having failed.
describe("writes that never came through this module", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStoreWatchForTest();
  });

  const armed = () => {
    let fire: ((projectId: string) => void) | undefined;
    vi.spyOn(ipc, "onResearchChanged").mockImplementation((cb) => {
      fire = cb;
      return Promise.resolve(() => {});
    });
    return () => fire;
  };

  it("re-reads a project when the store says that project moved", async () => {
    const get = armed();
    const list = vi.spyOn(ipc, "researchList").mockResolvedValue([]);
    await refresh("p1"); // the mount fetch, which is what puts p1 in the cache
    watchStore();
    list.mockClear();

    get()?.("p1");
    await Promise.resolve();
    expect(list).toHaveBeenCalledWith("p1", ACTIVE_STATUSES, 50);
  });

  it("subscribes once however many surfaces ask", () => {
    armed();
    watchStore();
    watchStore();
    watchStore();
    expect(ipc.onResearchChanged).toHaveBeenCalledTimes(1);
  });

  it("ignores a project nothing is showing", async () => {
    // `forget` drops a closed project's rows so they stop appearing in the
    // palette. A background write to it must not bring them back.
    const get = armed();
    const list = vi.spyOn(ipc, "researchList").mockResolvedValue([]);
    await refresh("p1");
    forget("p1");
    watchStore();
    list.mockClear();

    get()?.("p1");
    await Promise.resolve();
    expect(list).not.toHaveBeenCalled();
  });
});

// ---------- the closing half ----------

describe("settling an entry whose PR merged", () => {
  const summary = (over: Partial<ipc.ResearchSummary> = {}): ipc.ResearchSummary => ({
    id: "0102-stacked-pr-review-parity",
    title: "Stacked PR review parity",
    status: "implementing",
    digest: "",
    tags: [],
    agent: "claude",
    created_at: 0,
    updated_at: 0,
    source_count: 0,
    pr_count: 1,
    superseded_by: null,
    ...over,
  });

  const pr = { repo: "/repo", number: 447, url: "u", state: "open" };

  const seed = async (rows: ipc.ResearchSummary[]) => {
    vi.spyOn(ipc, "researchList").mockResolvedValue(rows);
    await refresh("p1");
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    // A resolved PR state is remembered for the session — the module never
    // asks twice about a merge — so each test starts from nothing known.
    resetPrLinkState();
    await seed([]);
  });

  it("moves an entry to implemented when every linked PR merged", async () => {
    await seed([summary()]);
    vi.spyOn(ipc, "researchGet").mockResolvedValue(entry({ links: {
      tickets: [], prs: [pr], branches: [], files: [], supersedes: [], superseded_by: null,
    } }));
    vi.spyOn(ipc, "ghPrState").mockResolvedValue("MERGED");
    vi.spyOn(ipc, "researchLink").mockResolvedValue({} as never);
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(1);
    expect(set).toHaveBeenCalledWith(
      "p1",
      "0102-stacked-pr-review-parity",
      "implemented",
      "Canopy",
      "every linked pull request merged",
    );
  });

  it("refreshes a PR on an entry it will not move", async () => {
    // The bug the user hit: an entry sitting in `researched` with a PR linked
    // to it. The old reconciler only looked at `implementing`, so the chip in
    // "What came of it" said "open" against a pull request that had merged.
    await seed([summary({ status: "researched" })]);
    vi.spyOn(ipc, "researchGet").mockResolvedValue(entry({ links: {
      tickets: [], prs: [pr], branches: [], files: [], supersedes: [], superseded_by: null,
    } }));
    vi.spyOn(ipc, "ghPrState").mockResolvedValue("MERGED");
    const link = vi.spyOn(ipc, "researchLink").mockResolvedValue({} as never);
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(0);
    expect(link).toHaveBeenCalledWith({
      projectId: "p1",
      id: "0102-stacked-pr-review-parity",
      pr: { ...pr, state: "merged" },
    });
    // The status move stays where it always was: only `implementing` is the
    // claim "this is being built", and only that claim closes on a merge.
    expect(set).not.toHaveBeenCalled();
  });

  it("never infers a merge from a PR it could not reach", async () => {
    await seed([summary()]);
    vi.spyOn(ipc, "researchGet").mockResolvedValue(entry({ links: {
      tickets: [], prs: [pr], branches: [], files: [], supersedes: [], superseded_by: null,
    } }));
    vi.spyOn(ipc, "ghPrState").mockRejectedValue(new Error("no gh"));
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });

  it("leaves an entry with nothing linked alone", async () => {
    await seed([summary({ pr_count: 0 })]);
    const get = vi.spyOn(ipc, "researchGet");
    const set = vi.spyOn(ipc, "researchSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

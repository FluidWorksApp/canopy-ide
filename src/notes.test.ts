import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import {
  ACTIVE_STATUSES,
  NEXT_STATUSES,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_ORDER,
  STATUS_STEP,
  noteContext,
  reconcileMerged,
  refresh,
} from "./notes";

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

  it("puts what is moving above the raw pile", () => {
    // The panel renders in this order, so it is the order the eye gets. The
    // whole reason `ready` exists is that it must not be buried under two
    // hundred untriaged thoughts.
    expect(STATUS_ORDER.indexOf("doing")).toBeLessThan(
      STATUS_ORDER.indexOf("ideation"),
    );
    expect(STATUS_ORDER.indexOf("ready")).toBeLessThan(
      STATUS_ORDER.indexOf("ideation"),
    );
    expect(STATUS_ORDER.at(-1)).toBe("archived");
  });

  it("keeps the archive out of the default worklist but not what got done", () => {
    expect(ACTIVE_STATUSES).not.toContain("archived");
    // Done stays: "what actually came out of my scratchpad" is the question
    // that makes keeping one feel worthwhile.
    expect(ACTIVE_STATUSES).toContain("done");
    expect(ACTIVE_STATUSES).toContain("ideation");
  });

  it("treats parked as an interruption, not a stage of its own", () => {
    // A note you put down has not travelled backwards.
    expect(STATUS_STEP.parked).toBe(STATUS_STEP.ready);
  });
});

// The test that matters most in this file. NEXT_STATUSES exists so the panel
// offers only moves the store will accept; the store's own machine is in
// src-tauri/src/notes.rs and is the authority.
//
// This reads that file and compares, rather than restating the table as a
// literal the way research.test.ts does. A copied table only catches the
// mistake if whoever edits the Rust also remembers to edit the copy — which is
// the same forgetting the test exists to catch. Parsing the source means the
// two cannot drift: change one side and this fails on the next run.
describe("the transition table mirrored from the Rust state machine", () => {
  const rustNext = (): Record<string, string[]> => {
    // Vitest runs from the repo root; import.meta.url is not a file: URL here
    // (same note as branchSwitchGuard.test.ts).
    const src = readFileSync(join(process.cwd(), "src-tauri/src/notes.rs"), "utf8");
    const fn = /fn next\(self\) -> &'static \[Status\] \{([\s\S]*?)\n    \}/.exec(src);
    if (!fn) throw new Error("could not find `fn next` in notes.rs");
    const table: Record<string, string[]> = {};
    for (const [, from, to] of fn[1].matchAll(/(\w+) => &\[([^\]]*)\],/g)) {
      table[from.toLowerCase()] = to
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    }
    return table;
  };

  it("matches notes.rs exactly", () => {
    const rust = rustNext();
    // A status Rust knows about and TypeScript doesn't is the drift this is
    // here for, so compare the key sets too rather than only the values.
    expect(Object.keys(rust).sort()).toEqual([...STATUSES].sort());
    for (const s of STATUSES) {
      expect(NEXT_STATUSES[s], `${s} — update both sides or neither`).toEqual(
        rust[s],
      );
    }
  });

  it("allows the three moves a scratchpad needs and a research entry doesn't", () => {
    // Skipping triage: a thought you act on the moment you have it.
    expect(NEXT_STATUSES.ideation).toContain("doing");
    // Reopening: "done" is one person's judgement and is routinely wrong.
    expect(NEXT_STATUSES.done).toContain("doing");
    // Un-archiving, or the archive becomes a place nobody puts anything —
    // and then the list rots instead, which is the failure being designed out.
    expect(NEXT_STATUSES.archived).toContain("ideation");
  });

  it("refuses the shortcut the machine exists to prevent", () => {
    // Nothing becomes done without having been worked on, or the status is
    // decoration and the list stops being worth reading.
    expect(NEXT_STATUSES.ideation).not.toContain("done");
    expect(NEXT_STATUSES.ready).not.toContain("done");
    // And un-archiving must not silently assert a triage decision nobody made.
    expect(NEXT_STATUSES.archived).not.toContain("ready");
    expect(NEXT_STATUSES.archived).not.toContain("done");
  });

  it("lets anything be put down", () => {
    for (const s of STATUSES) {
      if (s !== "archived") expect(NEXT_STATUSES[s], s).toContain("archived");
    }
  });
});

// ---------- the handoff ----------

const DIR = "/home/dev/.canopy/notes/p1/0007-tier-donations";

const note = (over: Partial<ipc.NoteDetail> = {}): ipc.NoteDetail => ({
  id: "0007-tier-donations",
  title: "Tier donations by amount",
  status: "ready",
  preview: "",
  tags: [],
  created_at: 0,
  updated_at: 0,
  attachment_count: 0,
  image_count: 0,
  file_count: 0,
  pr_count: 0,
  research_count: 0,
  body: "Show the tier on the profile badge.",
  context: "",
  origin: "spot",
  attachments: [],
  links: { prs: [], research: [], task_runs: [], branches: [], files: [] },
  history: [],
  dir: DIR,
  ...over,
});

describe("the brief an agent picks a note up with", () => {
  it("carries the thought in the user's own words", () => {
    const ctx = noteContext(note(), DIR);
    expect(ctx).toContain("Tier donations by amount");
    expect(ctx).toContain("Show the tier on the profile badge.");
    expect(ctx).toContain("0007-tier-donations");
  });

  it("points at attachments by path and says to open them", () => {
    const ctx = noteContext(
      note({
        attachments: [
          { file: "attachments/01-dropdown.png", kind: "image", title: "dropdown", origin: "pasted", bytes: 100 },
        ],
      }),
      DIR,
    );
    // The agent has file tools and no way to be handed a picture, so the path
    // is the whole mechanism — and it has to be absolute.
    expect(ctx).toContain(`${DIR}/attachments/01-dropdown.png`);
    // An agent given a path in prose will describe it rather than read it
    // unless told; this is that instruction.
    expect(ctx).toContain("open them with your file tools");
  });

  it("names the directory instead of every path once there are many", () => {
    const ctx = noteContext(
      note({
        attachments: Array.from({ length: 12 }, (_, i) => ({
          file: `attachments/${i}-shot.png`,
          kind: "image",
          title: `shot ${i}`,
          origin: "pasted",
          bytes: 10,
        })),
      }),
      DIR,
    );
    // A PTY prompt is one line; twelve absolute paths would spend all of it.
    expect(ctx).toContain("and 6 more");
    expect(ctx).toContain(`${DIR}/attachments/`);
    expect(ctx).not.toContain("attachments/11-shot.png");
  });

  it("marks the captured line numbers as historical, not current", () => {
    const ctx = noteContext(
      note({
        links: {
          prs: [],
          research: [],
          task_runs: [],
          branches: [],
          files: [
            { path: "src/PrView.tsx", start_line: 40, end_line: 52, rev: "58777d9", snapshot: null },
          ],
        },
      }),
      DIR,
    );
    expect(ctx).toContain("src/PrView.tsx:40-52");
    // Presented as current, a weeks-old line number sends the agent to code
    // that has moved — so the rev travels with it and the caveat is explicit.
    expect(ctx).toContain("58777d9");
    expect(ctx).toContain("from when the note was written");
  });

  it("flags the captured page context as possibly stale", () => {
    const ctx = noteContext(note({ context: "The user is looking at: file src/x.ts." }), DIR);
    expect(ctx).toContain("may be out of date");
  });

  it("says something useful for a note that is only a title", () => {
    const ctx = noteContext(note({ body: "", context: "", attachments: [] }), DIR);
    expect(ctx).toContain("Tier donations by amount");
    expect(ctx).not.toContain("undefined");
  });
});

// ---------- the closing half ----------

describe("settling a note whose PR merged", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // reconcileMerged reads the module cache, so seed it through the same door
    // the app uses rather than reaching into module state.
    vi.spyOn(ipc, "notesList").mockResolvedValue([]);
    await refresh("p1");
  });

  const seed = async (rows: ipc.NoteSummary[]) => {
    vi.spyOn(ipc, "notesList").mockResolvedValue(rows);
    await refresh("p1");
  };

  const row = (over: Partial<ipc.NoteSummary> = {}): ipc.NoteSummary => ({
    id: "0007-tier-donations",
    title: "Tier donations",
    status: "doing",
    preview: "",
    tags: [],
    created_at: 0,
    updated_at: 0,
    attachment_count: 0,
    image_count: 0,
    file_count: 0,
    pr_count: 1,
    research_count: 0,
    ...over,
  });

  const pr = { repo: "/repo", number: 281, url: "u", state: "open" };

  it("moves a note to done when every linked PR merged", async () => {
    await seed([row()]);
    vi.spyOn(ipc, "notesGet").mockResolvedValue(
      note({ links: { prs: [pr], research: [], task_runs: [], branches: [], files: [] } }),
    );
    vi.spyOn(ipc, "ghPrState").mockResolvedValue("MERGED");
    vi.spyOn(ipc, "notesLink").mockResolvedValue({} as never);
    const set = vi.spyOn(ipc, "notesSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(1);
    expect(set).toHaveBeenCalledWith(
      "p1",
      "0007-tier-donations",
      "done",
      "Canopy",
      "every linked pull request merged",
    );
  });

  it("never infers a merge from a PR it could not reach", async () => {
    // The quiet wrongness this guards: no gh, no network, or a repo that
    // moved, read as "shipped".
    await seed([row()]);
    vi.spyOn(ipc, "notesGet").mockResolvedValue(
      note({ links: { prs: [pr], research: [], task_runs: [], branches: [], files: [] } }),
    );
    vi.spyOn(ipc, "ghPrState").mockRejectedValue(new Error("no gh"));
    const set = vi.spyOn(ipc, "notesSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });

  it("leaves a note with nothing linked alone", async () => {
    // `doing` with no PR means nobody said what was carrying the work, not
    // that it finished.
    await seed([row({ pr_count: 0 })]);
    const get = vi.spyOn(ipc, "notesGet");
    const set = vi.spyOn(ipc, "notesSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("refreshes a PR's recorded state even when it did not merge", async () => {
    await seed([row()]);
    vi.spyOn(ipc, "notesGet").mockResolvedValue(
      note({ links: { prs: [pr], research: [], task_runs: [], branches: [], files: [] } }),
    );
    vi.spyOn(ipc, "ghPrState").mockResolvedValue("CLOSED");
    const link = vi.spyOn(ipc, "notesLink").mockResolvedValue({} as never);
    const set = vi.spyOn(ipc, "notesSetStatus").mockResolvedValue({} as never);

    expect(await reconcileMerged("p1")).toBe(0);
    // The detail view should say what actually happened to it.
    expect(link).toHaveBeenCalledWith({
      projectId: "p1",
      id: "0007-tier-donations",
      pr: { ...pr, state: "closed" },
    });
    expect(set).not.toHaveBeenCalled();
  });
});

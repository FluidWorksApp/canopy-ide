/** The bug this channel exists for, as a test: an agent parks a note through
 *  the context bridge, and the panel the user is looking at has to show it
 *  without the app being restarted. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import { NOTES_EVENT, cached, refresh, type NotesChanged } from "./notes";
import { registerStore, registeredStores, resetForTests } from "./stores";
import * as ipc from "./ipc";

const row = (over: Record<string, unknown> = {}) => ({
  id: "0002-perf",
  title: "Perf audit",
  status: "ideation",
  preview: "",
  tags: [],
  created_at: 1,
  updated_at: 1,
  attachment_count: 0,
  image_count: 0,
  file_count: 0,
  pr_count: 0,
  research_count: 0,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an agent's write reaching an open surface", () => {
  beforeEach(() => {
    mockCommands({ notes_list: () => [row()] });
  });

  it("routes a store:change to the store that owns it, and to no other", async () => {
    resetForTests();
    let fire: ((e: ipc.StoreChange) => void) | undefined;
    vi.spyOn(ipc, "onStoreChange").mockImplementation((cb) => {
      fire = cb;
      return Promise.resolve(() => {});
    });

    const notes = vi.fn();
    registerStore("notes", notes);
    await Promise.resolve();
    expect(fire, "the subscription never armed").toBeDefined();

    fire!({ store: "notes", scope: "p1", id: "0003-new" });
    expect(notes).toHaveBeenCalledWith({
      store: "notes",
      scope: "p1",
      id: "0003-new",
    });

    // A store with no handler must be dropped, not thrown on: Rust may emit a
    // variant this build's frontend does not route yet.
    expect(() => fire!({ store: "vault", scope: "x", id: "" })).not.toThrow();
    expect(notes).toHaveBeenCalledTimes(1);
  });

  it("puts an agent's new note into the cache and says which one moved", async () => {
    // The panel is open, so the project is in the cache.
    await refresh("p1");

    const heard: (NotesChanged | undefined)[] = [];
    const listener = (e: Event) =>
      heard.push((e as CustomEvent<NotesChanged | undefined>).detail);
    window.addEventListener(NOTES_EVENT, listener);

    // What the agent's write looks like by the time the store re-reads it.
    mockCommands({ notes_list: () => [row(), row({ id: "0003-new" })] });
    await refresh("p1", "0003-new");

    window.removeEventListener(NOTES_EVENT, listener);
    expect(cached("p1").map((r) => r.id)).toContain("0003-new");
    // The announcement carries which note moved, so a detail view showing a
    // different note can ignore it instead of making an IPC round trip.
    expect(heard.at(-1)).toEqual({ projectId: "p1", id: "0003-new" });
  });

  it("announces even when the summary list looks identical", async () => {
    // An archived note is not in ACTIVE_STATUSES, so an edit to one can never
    // change the list. Gating the announcement on a list comparison would
    // leave that tab stale — the same bug, one layer up.
    await refresh("p1");
    let heardCount = 0;
    const listener = () => (heardCount += 1);
    window.addEventListener(NOTES_EVENT, listener);
    await refresh("p1", "0002-perf");
    await refresh("p1", "0002-perf");
    window.removeEventListener(NOTES_EVENT, listener);
    expect(heardCount).toBe(2);
  });
});

describe("the subscription", () => {
  beforeEach(() => {
    resetForTests();
  });

  it("re-arms after a failed listen instead of going silent forever", async () => {
    // A listen that rejects once used to leave the app with no change channel
    // for the rest of the session, and no symptom until something failed to
    // appear. Retrying is what makes it safe to stop polling.
    vi.useFakeTimers();
    const onStoreChange = vi
      .spyOn(ipc, "onStoreChange")
      .mockRejectedValueOnce(new Error("bridge not up"))
      .mockResolvedValue(() => {});

    registerStore("notes", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(onStoreChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(onStoreChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it("reports what it routes, so the guard test can check coverage", () => {
    registerStore("notes", () => {});
    expect(registeredStores()).toContain("notes");
  });
});

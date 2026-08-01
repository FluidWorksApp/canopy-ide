import { beforeEach, describe, expect, it } from "vitest";
import { forgetSessions, restorableFrom } from "./restorable";
import type { SessionDigest } from "./ipc";

// A digest for a session whose terminal is gone: `surface` names a pty id, and
// passing no stats means no pty is alive, which is what makes it restorable.
const digest = (over: Partial<SessionDigest> = {}): SessionDigest => ({
  session_id: "s-1",
  agent: "claude",
  cwd: "/repo",
  surface: "7",
  updated: 1000,
  prompts: ["fix the flaky test"],
  ...over,
});

describe("restorableFrom", () => {
  beforeEach(() => localStorage.clear());

  it("never offers a micro-task, whose digest outlived the delete", () => {
    // Both ended the same way; only the marker separates them. The app deletes
    // micro digests when the task's terminal closes — this covers the force
    // quit that never ran that delete.
    const rows = restorableFrom(
      [digest({ session_id: "task", micro: true }), digest({ session_id: "chat" })],
      [],
      [],
    );
    expect(rows.map((r) => r.digest.session_id)).toEqual(["chat"]);
  });

  it("still offers digests written before the marker existed", () => {
    const old = digest();
    delete old.micro;
    expect(restorableFrom([old], [], [])).toHaveLength(1);
  });

  /** `--resume <id>` resolves inside the CLI's own config dir. */
  it("carries the account a session belongs to", () => {
    const [row] = restorableFrom([digest({ profile: "work" })], [], []);
    expect(row.profile).toBe("work");
  });

  it("treats a digest from before profiles as the default account", () => {
    const [row] = restorableFrom([digest()], [], []);
    expect(row.profile).toBe("default");
  });

  it("keeps each account's newest session in a shared directory", () => {
    // The per-directory collapse must not bury the second login: two accounts
    // working the same checkout are the point of profiles, and neither resumes
    // under the other's config dir.
    const rows = restorableFrom(
      [
        digest({ session_id: "work-new", profile: "work", updated: 300 }),
        digest({ session_id: "work-old", profile: "work", updated: 200 }),
        digest({ session_id: "personal", profile: "personal", updated: 100 }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.digest.session_id).sort()).toEqual(["personal", "work-new"]);
    expect(rows.find((r) => r.profile === "work")?.superseded.map((d) => d.session_id)).toEqual(
      ["work-old"],
    );
  });

  it("keeps a session out while its terminal is still alive", () => {
    const stats = [
      {
        id: 7, title: "claude", cwd: "/repo", total_cpu: 0, total_mem_bytes: 0,
        procs: [], ports: [], agent_hint: null,
        quiet_ms: null, since_input_ms: null, output_bytes: 0,
      },
    ];
    expect(restorableFrom([digest()], stats, ["s-1"])).toHaveLength(0);
    // Same session, that pty gone: back on the list.
    expect(restorableFrom([digest()], [], ["s-1"])).toHaveLength(1);
  });

  it("offers only the newest session per directory", () => {
    // A checkout accrues one digest per conversation, all sharing its cwd —
    // 64 of them in this repo. Offering every one made a list nobody reads and
    // a "Restore all" that spawns 64 agents. Newest wins; the rest stay on
    // disk, they are just not offered.
    const rows = restorableFrom(
      [
        digest({ session_id: "old", updated: 100 }),
        digest({ session_id: "newest", updated: 300 }),
        digest({ session_id: "middle", updated: 200 }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.digest.session_id)).toEqual(["newest"]);
  });

  it("hands the row the sessions it stands in for, so forget can take them too", () => {
    // Without this, dismissing a row promotes the next-oldest in its directory
    // and you dismiss the same directory 64 times.
    const rows = restorableFrom(
      [
        digest({ session_id: "newest", updated: 300 }),
        digest({ session_id: "older", updated: 200 }),
        digest({ session_id: "oldest", updated: 100 }),
      ],
      [],
      [],
    );
    expect(rows[0].superseded.map((d) => d.session_id)).toEqual(["older", "oldest"]);
    // Forgetting the whole group is what clears the directory.
    forgetSessions([rows[0].digest, ...rows[0].superseded]);
    expect(
      restorableFrom(
        [
          digest({ session_id: "newest", updated: 300 }),
          digest({ session_id: "older", updated: 200 }),
          digest({ session_id: "oldest", updated: 100 }),
        ],
        [],
        [],
      ),
    ).toHaveLength(0);
  });

  it("keeps one row per directory, and per agent within one", () => {
    // Worktrees are the point: each is its own directory, so each keeps its own
    // most-recent session rather than being collapsed into the main checkout's.
    const rows = restorableFrom(
      [
        digest({ session_id: "main", resume_cwd: "/repo" }),
        digest({ session_id: "tree", resume_cwd: "/repo/.worktrees/feat" }),
        digest({ session_id: "codex-main", resume_cwd: "/repo", agent: "codex" }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.digest.session_id).sort()).toEqual([
      "codex-main",
      "main",
      "tree",
    ]);
  });

  it("falls through to the next session in a directory when the newest can't resume", () => {
    // The unusable row is dropped before the collapse, so an unresumable newest
    // doesn't take its whole directory down with it.
    const rows = restorableFrom(
      [
        digest({ session_id: "newest", updated: 300, resumable: false }),
        digest({ session_id: "older", updated: 200 }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.digest.session_id)).toEqual(["older"]);
  });

  it("drops sessions with no way back, rather than offering an unusable row", () => {
    // No transcript found on disk for this id (resume_location said so), so
    // every --resume against it fails.
    expect(restorableFrom([digest({ resumable: false })], [], [])).toHaveLength(0);
    // Same for a CLI that can't reopen a specific session by id at all.
    expect(restorableFrom([digest({ agent: "aider" })], [], [])).toHaveLength(0);
    // Every row that survives carries the command that reopens it.
    expect(restorableFrom([digest()], [], [])[0].command).toContain("s-1");
  });

  it("drops a promptless claude session, which could only fail to resume", () => {
    expect(restorableFrom([digest({ prompts: [] })], [], [])).toHaveLength(0);
    // Other CLIs capture prompts best-effort, so an empty list means nothing.
    expect(restorableFrom([digest({ prompts: [], agent: "codex" })], [], [])).toHaveLength(1);
  });
});

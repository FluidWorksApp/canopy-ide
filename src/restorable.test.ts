import { beforeEach, describe, expect, it } from "vitest";
import { restorableFrom } from "./restorable";
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

  /** `--resume <id>` is resolved inside the CLI's own config dir, so the row
   *  has to carry the account that owns the conversation. Restoring it under
   *  another login doesn't reopen something else — it reports a session that
   *  plainly exists as missing. */
  it("carries the account a session belongs to", () => {
    const [row] = restorableFrom([digest({ profile: "work" })], [], []);
    expect(row.profile).toBe("work");
  });

  it("treats a digest from before profiles as the default account", () => {
    const [row] = restorableFrom([digest()], [], []);
    expect(row.profile).toBe("default");
  });

  it("keeps a session out while its terminal is still alive", () => {
    const stats = [
      { id: 7, title: "claude", cwd: "/repo", total_cpu: 0, total_mem_bytes: 0, procs: [], ports: [], agent_hint: null },
    ];
    expect(restorableFrom([digest()], stats, ["s-1"])).toHaveLength(0);
    // Same session, that pty gone: back on the list.
    expect(restorableFrom([digest()], [], ["s-1"])).toHaveLength(1);
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

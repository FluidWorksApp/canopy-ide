/// <reference types="node" />
// Nothing offers to resume a conversation whose directory is gone.
//
// `restoreCommand` answers a different question from the one that matters here:
// it says whether the CLI can reopen *any* conversation by id, not whether this
// particular transcript can still be reached. `resumable` is the backend's
// verdict on that second question (agents.rs `resume_location`), and it is
// false exactly when the directory the transcript is filed under has gone —
// a deleted `.claude/worktrees/<name>` being the everyday case.
//
// Resuming anyway is not a no-op that prints an error. The pty falls back to
// `~`, the CLI answers "No conversation found with session ID: …", and that
// run's hooks write the home directory onto the digest — so every later attempt
// starts from `~` too, including ones that would have worked. The failure
// poisons the record it reads.
//
// `restorableFrom` has always applied the rule; the message-an-agent path did
// not, and spawned into the dead directory (fixed in 1295734). These two guards
// exist because the bug was precisely two paths disagreeing about one rule, and
// nothing then in the suite could tell.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restorableFrom } from "./restorable";
import type * as ipc from "./ipc";

const digest = (over: Partial<ipc.SessionDigest> = {}): ipc.SessionDigest =>
  ({
    session_id: "s1",
    agent: "claude",
    cwd: "/repo",
    resume_cwd: "/repo",
    updated: 100,
    prompts: ["fix the login redirect"],
    ...over,
  }) as ipc.SessionDigest;

describe("the rule, where it is implemented", () => {
  it("does not offer a session whose transcript directory is gone", () => {
    // The reference implementation the source guard below points at.
    expect(restorableFrom([digest({ resumable: false })], [], [])).toHaveLength(0);
  });

  it("still offers one whose directory is intact", () => {
    expect(restorableFrom([digest({ resumable: true })], [], [])).toHaveLength(1);
    // Absent means "no verdict recorded" — a pre-upgrade digest, or a CLI whose
    // sessions are read from its own store. Withholding those would empty the
    // list for every agent that predates the field.
    expect(restorableFrom([digest()], [], [])).toHaveLength(1);
  });
});

describe("every other path that resumes applies it too", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/ProjectView/index.tsx"),
    "utf8",
  );

  /** The body of `messageAgent`'s resume arm: from the point it has a resume
   *  command to the point it spawns a terminal with it. Whatever else that arm
   *  grows, the refusal has to happen inside this window — after it, the
   *  terminal already exists and the damage is done. */
  const resumeArm = (): string => {
    const from = source.indexOf("const cmd = restoreCommand(agentId, sessionId);");
    expect(from, "messageAgent's resume arm has moved or been renamed").toBeGreaterThan(-1);
    const to = source.indexOf("addTerminal(", from);
    expect(to, "messageAgent no longer spawns a terminal to resume into").toBeGreaterThan(from);
    return source.slice(from, to);
  };

  it("refuses to spawn when the backend says the directory is gone", () => {
    expect(
      /resumable\s*===\s*false/.test(resumeArm()),
      "messageAgent must consult digest.resumable before resuming — see 0004 in the scratchpad",
    ).toBe(true);
  });

  it("refuses by telling the caller, not by spawning and hoping", () => {
    const arm = resumeArm();
    const refusal = arm.slice(arm.indexOf("resumable"));
    // A `delivered: false` return is what stops the caller reporting success
    // and what puts the reason in front of the user. Falling through to the
    // spawn is the bug this file is named after.
    expect(
      /delivered:\s*false/.test(refusal),
      "the resumable check must return delivered: false rather than fall through",
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isStaleResume } from "./companionSession";

// The bug this whole branch exists for: the very first launch failed (a missing
// CLI flag), but the session had already been marked as "this CLI has a
// conversation" the moment the process spawned. Every launch afterwards passed
// --resume for a conversation that never existed, the CLI printed "No
// conversation found" and exited instantly, and the panel said "Not connected"
// forever with no way for the user to know why.
describe("telling a stale session id from a broken CLI", () => {
  it("treats a resume that never reached ready as stale", () => {
    expect(isStaleResume({ resumed: true, ready: false }, false)).toBe(true);
  });

  it("leaves a resume that DID connect alone", () => {
    // It came up and then exited later — that is a session ending, not a bad id.
    expect(isStaleResume({ resumed: true, ready: true }, false)).toBe(false);
  });

  it("does not blame the session id for a fresh launch that died", () => {
    // Nothing was resumed, so there is no id to forget; retrying would be a
    // spawn loop against a CLI that cannot start.
    expect(isStaleResume({ resumed: false, ready: false }, false)).toBe(false);
  });

  it("never retries the retry", () => {
    expect(isStaleResume({ resumed: true, ready: false }, true)).toBe(false);
  });

  it("is safe with no attempt recorded", () => {
    expect(isStaleResume(null, false)).toBe(false);
  });
});

describe("no agent CLI installed", () => {
  it("is a distinct state from a failure", async () => {
    // The companion ships on. On a machine with no CLI yet that is the
    // ordinary state, and the surfaces render nothing for it — a mascot
    // wearing a permanent error face would be a worse first impression than
    // no mascot.
    const { startCompanion, companionState } = await import("./companionSession");
    await startCompanion({ projects: [], installed: () => false, tools: [] });
    expect(companionState().status).toBe("unavailable");
    expect(companionState().error).toBeNull();
  });
});

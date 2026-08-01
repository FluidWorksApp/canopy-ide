import { describe, expect, it } from "vitest";
import { isStaleResume, retryDelay } from "./companionSession";

// A launch that failed used to sit failed: only a *stale resume* healed itself,
// and everything else waited for the user to notice a dead mascot and click
// Retry. A transient failure — the CLI's own service briefly unreachable, a
// machine still waking — is the common case and should never reach them.
describe("trying a failed launch again", () => {
  it("backs off rather than hammering", () => {
    const first = retryDelay(0)!;
    const second = retryDelay(1)!;
    const third = retryDelay(2)!;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("gives up, so a permanently broken CLI is not a spawn loop", () => {
    // A missing binary or a bad flag fails identically forever; retrying it
    // costs the user money and tells them nothing. Three tries, then the panel
    // says so and a person decides.
    expect(retryDelay(3)).toBeNull();
    expect(retryDelay(9)).toBeNull();
  });

  it("finishes the ladder inside a minute", () => {
    // Long enough to outlast a blip, short enough that a user who steps away
    // for coffee comes back to a working companion rather than a dead one.
    const total = [0, 1, 2].reduce((sum, n) => sum + (retryDelay(n) ?? 0), 0);
    expect(total).toBeLessThanOrEqual(60_000);
  });
});

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

describe("recovering once a CLI appears", () => {
  it("is not a dead end — a later start is allowed to proceed", async () => {
    // `unavailable` must stay retryable. The companion ships on, so a machine
    // with no agent CLI starts there; installing one from Settings has to
    // bring it to life then and there, not on the next app launch. The guard
    // in startCompanion only short-circuits while a session is actually
    // running, which is what makes the retry possible.
    const mod = await import("./companionSession");
    await mod.startCompanion({ projects: [], installed: () => false, tools: [] });
    expect(mod.companionState().status).toBe("unavailable");

    // Now one exists. The spawn itself cannot succeed under vitest — there is
    // no Tauri — but it must get far enough to try, which is the thing that
    // was broken.
    await mod.startCompanion({ projects: [], installed: () => true, tools: [] });
    expect(mod.companionState().status).not.toBe("unavailable");
  });
});

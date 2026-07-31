// If this goes red, the companion has become visible to something.
//
// The companion is one session that must appear in no list of sessions. It is
// the user's assistant, not one of their coding agents: no tab, not started on
// a branch, and a row for it in the Agents panel — or in `canopy_agents`, where
// another agent could then read its conversation or type into it — is a leak,
// not a feature.
//
// The enforcement is structural rather than a filter each surface remembers:
// `canopy_hook` writes no digest at all for a session carrying
// CANOPY_COMPANION, and every listing Canopy has is built from those digests.
// A session with no digest is invisible everywhere at once, including in
// surfaces written after this test.
//
// Do not "fix" a failure here by adding a filter to whichever panel started
// showing it. The filter is the thing this test exists to make unnecessary; a
// surface that needs one is a surface the next surface will forget.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the companion session is invisible by construction", () => {
  it("is launched with the marker the sidecar gates on", () => {
    const session = read("src/companionSession.ts");
    expect(session).toContain('["CANOPY_COMPANION", "1"]');
  });

  it("makes the hook skip the digest entirely, rather than tagging one", () => {
    const hook = read("src-tauri/src/bin/canopy_hook.rs");
    expect(hook).toContain("fn is_companion_session()");
    expect(hook).toContain('std::env::var("CANOPY_COMPANION")');
    // The guard has to be the first thing update_digest does. A digest written
    // and then deleted is a race every crash loses.
    const digest = hook.slice(hook.indexOf("fn update_digest("));
    const guard = digest.indexOf("is_companion_session()");
    const firstWrite = digest.indexOf("create_dir_all");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstWrite);
  });

  it("never lands in the PTY table on the structured tier", () => {
    // The streaming tier runs on plain pipes (companion.rs), so it is not a
    // terminal at all — nothing that enumerates terminals can reach it. This
    // pins that: a move to pty_spawn for the structured path would silently
    // give the companion a row in every terminal listing.
    const transport = read("src/companionTransport.ts");
    const structured = transport.slice(
      transport.indexOf("export async function startStructured"),
      transport.indexOf("// --------------------------------------------------------------- terminal"),
    );
    expect(structured).toContain("companionSpawn");
    expect(structured).not.toContain("ptySpawn");
  });

  it("uses a detached PTY on the terminal tier — never one that opens a tab", () => {
    // `ptySpawnDetached` is the no-tab spawn; `ptySpawn` announces itself and
    // the app answers by opening one.
    const transport = read("src/companionTransport.ts");
    const terminal = transport.slice(
      transport.indexOf("export async function startTerminal"),
    );
    expect(terminal).toContain("ptySpawnDetached");
    expect(terminal).not.toContain("ipc.ptySpawn(");
    expect(terminal).not.toContain("spawnHeadless");
  });

  it("is not offered for restore, resume or hibernation", () => {
    // All three read the digests, so this is already true — but naming it here
    // is what makes a future "restore every session we know about" notice the
    // companion is deliberately not among them.
    const hook = read("src-tauri/src/bin/canopy_hook.rs");
    const guardDoc = hook.slice(
      hook.indexOf("/// The companion (Ash) is one session"),
      hook.indexOf("fn is_companion_session()"),
    );
    expect(guardDoc).toContain("appear in no list of sessions");
  });
});

describe("the companion runs in no project", () => {
  it("passes no project root as its cwd", () => {
    // Running inside a repo auto-loads that repo's CLAUDE.md, and the
    // companion then follows one project's coding-agent rules while answering
    // about all of them — which is how it came to refuse a server it had been
    // asked to start. Verified against the CLI: a neutral cwd plus --add-dir
    // loads no project instructions at all.
    const session = readFileSync(join(root, "src/companionSession.ts"), "utf8");
    expect(session).toContain("const cwd = undefined");
    expect(session).not.toContain("const cwd = roots[0]");
  });

  it("has the Rust side put it in its own directory", () => {
    const rust = readFileSync(join(root, "src-tauri/src/companion.rs"), "utf8");
    expect(rust).toContain("fn companion_home()");
    expect(rust).toContain("create_dir_all");
  });
});

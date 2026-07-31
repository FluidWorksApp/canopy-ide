// If this goes red, the companion's authority setting has stopped meaning what
// it says.
//
// Authority is enforced by *withholding the tool*, in the sidecar, not by
// asking the agent to behave — a tool that is absent cannot be called, and a
// rule in a prompt is one the agent can reason its way past. The companion is
// the one agent that acts in projects the user is not looking at, so that
// distinction is the whole safety story.
//
// The list of "what changes the world" therefore lives in two places (Rust, to
// enforce; TypeScript, to describe), and the two drifting apart is the failure
// this test exists to catch: a tool added to one and not the other is either
// silently callable when the user asked to be asked, or silently missing when
// they said go ahead.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MUTATING_TOOLS, COMPANION_TOOLS, companionToolNames } from "./companionTools";

const hook = readFileSync(
  join(process.cwd(), "src-tauri/src/bin/canopy_hook.rs"),
  "utf8",
);

/** The Rust list, read out of the source it is declared in. */
function rustMutatingTools(): string[] {
  const start = hook.indexOf("const COMPANION_MUTATING_TOOLS: &[&str] = &[");
  expect(start).toBeGreaterThan(-1);
  const body = hook.slice(start, hook.indexOf("];", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("the mutating-tool list is the same on both sides", () => {
  it("matches, name for name", () => {
    expect(rustMutatingTools().sort()).toEqual([...MUTATING_TOOLS].sort());
  });
});

describe("authority withholds rather than asks", () => {
  it("gives an answer-only companion nothing that changes the world", () => {
    const tools = companionToolNames([], "read");
    for (const name of MUTATING_TOOLS) expect(tools).not.toContain(name);
  });

  it("withholds under ask-first too, while the confirm gate is unbuilt", () => {
    // Deliberate and temporary: shipping the tools before `canopy_confirm`
    // exists would make the setting say "ask first" while the companion acted
    // freely. When the gate lands, this expectation flips — and it should only
    // flip together with the gate.
    const tools = companionToolNames([], "confirm");
    for (const name of MUTATING_TOOLS) expect(tools).not.toContain(name);
    expect(COMPANION_TOOLS).toContain("canopy_confirm");
  });

  it("gives an autonomous companion the lot", () => {
    const tools = companionToolNames([], "auto");
    for (const name of MUTATING_TOOLS) expect(tools).toContain(name);
  });

  it("leaves reading alone at every authority", () => {
    for (const authority of ["read", "confirm", "auto"] as const) {
      const tools = companionToolNames([], authority);
      expect(tools).toContain("canopy_project");
      expect(tools).toContain("canopy_diagnostics");
      expect(tools).toContain("canopy_workspace");
      expect(tools).toContain("canopy_workspace_git");
    }
  });

  it("still honours Settings → Agents for the shared tools", () => {
    const tools = companionToolNames(["canopy_diagnostics"], "auto");
    expect(tools).not.toContain("canopy_diagnostics");
    // The companion's own tools are not on that screen, so they survive it.
    expect(tools).toContain("canopy_workspace");
  });

  it("is enforced in the sidecar, not only in the brief", () => {
    // The brief is what the agent reads; the sidecar is what it can call. A
    // filter that existed only in the prompt builder would describe a
    // restriction that was not there.
    expect(hook).toContain("fn apply_companion_authority(");
    expect(hook).toContain("apply_companion_authority(&mut tools)");
    expect(hook).toContain('std::env::var("CANOPY_COMPANION_POLICY")');
  });
});

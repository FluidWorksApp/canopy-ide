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
import {
  MUTATING_TOOLS,
  COMPANION_TOOLS,
  PER_PROJECT_TOOLS,
  companionToolNames,
} from "./companionTools";

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

  it("keeps the tools under ask-first, because the gate is in the call path", () => {
    // Withholding them here would only mean the companion could not act at
    // all: `companion_gate` confirms on the way through, whether or not the
    // agent thought to ask.
    const tools = companionToolNames([], "confirm");
    for (const name of MUTATING_TOOLS) expect(tools).toContain(name);
    expect(COMPANION_TOOLS).toContain("canopy_confirm");
  });

  it("gates every mutating tool in the call path, not in the prompt", () => {
    // The keystone. If this goes red, "ask first" has quietly become an
    // instruction the agent may ignore rather than a gate it cannot pass.
    expect(hook).toContain("fn companion_gate(");
    // At the very top of dispatch, so no tool handler has to remember it and
    // a tool added later is covered by being on the mutating list.
    const dispatch = hook.slice(hook.indexOf("fn call_tool("));
    const gate = dispatch.indexOf("companion_gate(name, args)");
    const firstArm = dispatch.indexOf('"canopy_project"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstArm);
  });

  it("treats a missing or malformed answer as refusal, never as consent", () => {
    // The one place failing closed matters more than failing usefully.
    const gate = hook.slice(hook.indexOf("fn companion_gate("), hook.indexOf("fn call_tool("));
    expect(gate).toContain(".unwrap_or(false)");
    expect(gate).toContain("so it was not done");
  });

  it("describes the action from the arguments, not from the agent's words", () => {
    // The value of the chip is showing what will happen, not what the agent
    // says will happen — an agent that misunderstood its own task is exactly
    // what this catches.
    expect(hook).toContain("fn describe_action(");
    const describe = hook.slice(
      hook.indexOf("fn describe_action("),
      hook.indexOf("fn companion_gate("),
    );
    expect(describe).toContain('"canopy_start_server"');
    expect(describe).toContain('"canopy_browser_eval"');
  });

  it("still removes them entirely under answer-only", () => {
    // Absent beats instructed: there is no gate to pass because there is no
    // tool to call.
    const rust = hook.slice(hook.indexOf("fn apply_companion_authority("));
    expect(rust).toContain('!= "deny"');
    expect(companionToolNames([], "read")).not.toContain("canopy_start_server");
  });

  it("gives an autonomous companion the lot", () => {
    const tools = companionToolNames([], "auto");
    for (const name of MUTATING_TOOLS) expect(tools).toContain(name);
  });

  it("leaves reading alone at every authority", () => {
    for (const authority of ["read", "confirm", "auto"] as const) {
      const tools = companionToolNames([], authority);
      // canopy_project is deliberately NOT here — see the withheld group
      // below. canopy_workspace is what answers that question for an agent
      // that is in no project.
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

describe("tools that cannot answer for this agent are withheld", () => {
  it("keeps the per-project tools out of the companion's list", () => {
    // Asking it not to call canopy_project did not work: it called it, got
    // whichever project the bridge routed it to, and told the user their other
    // projects did not exist. A tool that cannot answer correctly for an agent
    // in no project does not belong in that agent's list.
    for (const authority of ["read", "confirm", "auto"] as const) {
      const tools = companionToolNames([], authority);
      for (const name of PER_PROJECT_TOOLS) expect(tools).not.toContain(name);
    }
  });

  it("still gives it the cross-project tool that answers the same question", () => {
    expect(companionToolNames([], "read")).toContain("canopy_workspace");
  });

  it("matches the Rust list, name for name", () => {
    const start = hook.indexOf("const COMPANION_BLIND_TOOLS: &[&str] = &[");
    expect(start).toBeGreaterThan(-1);
    const body = hook.slice(start, hook.indexOf("];", start));
    const rust = [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rust.sort()).toEqual([...PER_PROJECT_TOOLS].sort());
  });

  it("withholds them at every authority, not only read-only", () => {
    // They are wrong for this agent regardless of what it may do.
    const rust = hook.slice(hook.indexOf("fn apply_companion_authority("));
    const blind = rust.indexOf("COMPANION_BLIND_TOOLS");
    const policyGate = rust.indexOf('CANOPY_COMPANION_POLICY');
    expect(blind).toBeGreaterThan(-1);
    // Filtered before the policy early-return, or "act freely" would keep them.
    expect(blind).toBeLessThan(policyGate);
  });
});

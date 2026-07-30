// The Settings → Agents list and the sidecar's own tool descriptors are two
// hand-written copies of the same set of names (see the note at the top of
// agentTools.ts). The name is the key the sidecar filters the disable list on,
// so a tool listed here under a name the sidecar doesn't know is a switch
// wired to nothing — it looks like it turns the tool off and never does.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AGENT_TOOL_GROUPS, ALL_AGENT_TOOLS } from "./agentTools";

const HOOK = join(process.cwd(), "src-tauri/src/bin/canopy_hook.rs");

/** Every `"name": "canopy_…"` in the sidecar's tool descriptors. */
const sidecarTools = (): Set<string> => {
  const src = readFileSync(HOOK, "utf8");
  return new Set(
    [...src.matchAll(/"name":\s*"(canopy_[a-z_]+)"/g)].map((m) => m[1]),
  );
};

describe("the agent tool list", () => {
  it("only offers switches for tools the sidecar actually has", () => {
    const known = sidecarTools();
    expect(known.size).toBeGreaterThan(20);
    const unknown = ALL_AGENT_TOOLS.filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
  });

  it("names each tool once", () => {
    expect(new Set(ALL_AGENT_TOOLS).size).toBe(ALL_AGENT_TOOLS.length);
  });

  it("lets the user take away an agent's ability to close itself", () => {
    // The one tool that ends a session outright. It is on by default, so the
    // switch is the only way to say no to it — and it can only ever be missing
    // from here by mistake.
    expect(ALL_AGENT_TOOLS).toContain("canopy_close_session");
    expect(sidecarTools()).toContain("canopy_close_session");
    const row = AGENT_TOOL_GROUPS.flatMap((g) => g.tools).find(
      (t) => t.name === "canopy_close_session",
    );
    expect(row?.note).toMatch(/never another/i);
  });
});

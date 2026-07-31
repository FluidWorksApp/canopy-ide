import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_GROUPS, ALL_AGENT_TOOLS } from "./agentTools";

// Settings → Agents lists these switches; the tools themselves are defined in
// the MCP sidecar (src-tauri/src/bin/canopy_hook.rs). Two hand-maintained lists
// in two languages drift, and the failure is silent in the worst direction: a
// switch that names a tool which does not exist looks like it works and turns
// nothing off.
//
// Vitest runs from the repo root; import.meta.url is not a file: URL here
// (same note as branchSwitchGuard.test.ts).
const HOOK = readFileSync(
  join(process.cwd(), "src-tauri/src/bin/canopy_hook.rs"),
  "utf8",
);

const definedInSidecar = new Set(
  [...HOOK.matchAll(/"name":\s*"(canopy_[a-z_]+)"/g)].map((m) => m[1]),
);

describe("the Settings → Agents tool list", () => {
  it("only offers switches for tools the sidecar actually defines", () => {
    const orphans = ALL_AGENT_TOOLS.filter((t) => !definedInSidecar.has(t));
    expect(orphans, "a switch naming no tool silently does nothing").toEqual([]);
  });

  // The reverse is deliberately not asserted. A dozen tools — the Android
  // device set, and canopy_browser_point — are defined but intentionally have
  // no switch, because the surface they belong to is not finished. Asserting
  // both directions would mean listing those exceptions here and keeping the
  // exception list current, which is a third thing to drift.

  it("names and explains every switch it shows", () => {
    for (const group of AGENT_TOOL_GROUPS) {
      expect(group.label, group.id).toBeTruthy();
      expect(group.blurb, group.id).toBeTruthy();
      for (const tool of group.tools) {
        expect(tool.label, tool.name).toBeTruthy();
        expect(tool.note, tool.name).toBeTruthy();
      }
    }
  });

  it("lists each tool once", () => {
    expect(ALL_AGENT_TOOLS.length).toBe(new Set(ALL_AGENT_TOOLS).size);
  });

  it("offers the scratchpad pair, split read from write", () => {
    // The split is what lets the reader be auto-approved by a host; a single
    // switch covering both would make that annotation meaningless.
    expect(ALL_AGENT_TOOLS).toContain("canopy_notes");
    expect(ALL_AGENT_TOOLS).toContain("canopy_notes_write");
  });
});

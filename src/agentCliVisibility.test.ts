import { describe, expect, it } from "vitest";
import { partitionBuiltins } from "./agentCliVisibility";

const defs = [
  { id: "claude", bin: "claude" },
  { id: "amp", bin: "amp" },
  { id: "aider", bin: "aider" },
  { id: "grok", bin: "grok" },
];
const resolveBin = (d: { bin: string }) => d.bin;

describe("partitionBuiltins", () => {
  it("shows only installed CLIs", () => {
    const { shown, hidden } = partitionBuiltins(defs, {
      found: { claude: true, amp: false, aider: false },
      overrides: {},
      revealed: new Set(),
      resolveBin,
    });
    expect(shown.map((d) => d.id)).toEqual(["claude"]);
    expect(hidden.map((d) => d.id)).toEqual(["amp", "aider", "grok"]);
  });

  it("keeps a CLI the person gave a path for, even when it is not found", () => {
    const { shown } = partitionBuiltins(defs, {
      found: { claude: true, amp: false },
      overrides: { amp: "/opt/amp" },
      revealed: new Set(),
      resolveBin,
    });
    expect(shown.map((d) => d.id)).toEqual(["claude", "amp"]);
  });

  it("shows one the person added from the list", () => {
    const { shown } = partitionBuiltins(defs, {
      found: {},
      overrides: {},
      revealed: new Set(["grok"]),
      resolveBin,
    });
    expect(shown.map((d) => d.id)).toEqual(["grok"]);
  });

  it("uses the resolved binary, so an override probes under its own name", () => {
    const { shown } = partitionBuiltins(defs, {
      found: { "my-claude": true },
      overrides: {},
      revealed: new Set(),
      resolveBin: (d) => (d.id === "claude" ? "my-claude" : d.bin),
    });
    expect(shown.map((d) => d.id)).toEqual(["claude"]);
  });
});

import { listedForLaunch } from "./agentCliVisibility";

describe("listedForLaunch", () => {
  const clis = [{ bin: "claude" }, { bin: "amp" }, { bin: "grok" }];
  it("hides only the agents the probe said are missing", () => {
    expect(listedForLaunch(clis, { claude: true, amp: false }).map((c) => c.bin)).toEqual(["claude", "grok"]);
  });
  it("keeps everything while the probe has not answered", () => {
    expect(listedForLaunch(clis, {})).toHaveLength(3);
  });
});

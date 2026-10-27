import { afterEach, describe, expect, it } from "vitest";
import { chosenBrainId, installedBrain, resolveBrain } from "./brain";
import { AGENT_CLIS } from "./projects";
import { getSettings, updateSettings } from "./settings";

// The registry is the real one, so these ids are the ones a user sees in
// Settings. `installed` is the only thing stubbed, because "is it on this
// machine" is the one input a test cannot have an opinion about.
const only = (...bins: string[]) => (bin: string) => bins.includes(bin);
const original = getSettings().defaultAgent;

afterEach(() => updateSettings({ defaultAgent: original }));

describe("resolveBrain", () => {
  it("is the chosen CLI when it is installed", () => {
    updateSettings({ defaultAgent: "codex" });
    expect(resolveBrain(only("claude", "codex"))?.id).toBe("codex");
  });

  it("falls back to an installed CLI when the chosen one isn't here", () => {
    // A preference carried over from another machine must not power nothing.
    updateSettings({ defaultAgent: "opencode" });
    expect(resolveBrain(only("codex"))?.id).toBe("codex");
  });

  it("names the chosen CLI when nothing is detected, not the registry's first", () => {
    // Detection lags a fresh install; endorsing AGENT_CLIS[0] there would put
    // one vendor in front of a setting that says otherwise.
    updateSettings({ defaultAgent: "amp" });
    expect(AGENT_CLIS[0]?.id).not.toBe("amp");
    expect(resolveBrain(() => false)?.id).toBe("amp");
  });

  it("uses the registry's first entry only when the choice names nothing", () => {
    updateSettings({ defaultAgent: "not-an-agent" });
    expect(resolveBrain(() => false)).toBe(AGENT_CLIS[0]);
  });

  it("matches on the installed binary, not the id", () => {
    // cursor's id and binary differ; matching the id against PATH would call
    // an installed Cursor absent.
    updateSettings({ defaultAgent: "cursor" });
    expect(resolveBrain(only("cursor-agent", "claude"))?.id).toBe("cursor");
  });
});

describe("installedBrain", () => {
  it("is the chosen brain when it is installed", () => {
    updateSettings({ defaultAgent: "codex" });
    expect(installedBrain(only("codex"))?.id).toBe("codex");
  });

  it("never swaps in another vendor when the chosen one is missing", () => {
    updateSettings({ defaultAgent: "claude" });
    expect(installedBrain(only("codex"))).toBeNull();
  });

  it("is null rather than an absent vendor when nothing is installed", () => {
    updateSettings({ defaultAgent: "claude" });
    expect(installedBrain(() => false)).toBeNull();
  });
});

describe("chosenBrainId", () => {
  it("is the setting, installed or not — ranking does its own gating", () => {
    updateSettings({ defaultAgent: "amp" });
    expect(chosenBrainId()).toBe("amp");
  });

  it("passes an id the registry doesn't know through unchanged", () => {
    // Swapping it for another vendor here would be a silent substitution.
    updateSettings({ defaultAgent: "in-house-agent" });
    expect(chosenBrainId()).toBe("in-house-agent");
  });
});

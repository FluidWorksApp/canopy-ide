import { beforeEach, describe, expect, it } from "vitest";
import * as preferences from "./preferences";
import { automaticPreference, inheritPreference, targetPreference } from "./types";

describe("placement preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults global placement to Automatic and overrides to Use default", () => {
    expect(preferences.getGlobalPreference()).toEqual(automaticPreference());
    expect(preferences.getProjectPreference("a")).toEqual(inheritPreference());
    expect(preferences.getAgentPreference("claude")).toEqual(inheritPreference());
  });

  it("round-trips concrete targets without collapsing their stable IDs", () => {
    preferences.setGlobalPreference(targetPreference({ kind: "local" }));
    preferences.setProjectPreference("a", targetPreference({ kind: "remote", workspaceId: "workspace-a" }));
    preferences.setAgentPreference("claude", targetPreference({ kind: "t3", machineId: "machine-a" }));
    expect(preferences.getGlobalPreference()).toEqual(targetPreference({ kind: "local" }));
    expect(preferences.getProjectPreference("a")).toEqual(targetPreference({ kind: "remote", workspaceId: "workspace-a" }));
    expect(preferences.getAgentPreference("claude")).toEqual(targetPreference({ kind: "t3", machineId: "machine-a" }));

    preferences.setProjectPreference("b", targetPreference({ kind: "remote", workspaceId: "workspace-b" }));
    expect(preferences.getProjectPreference("a")).not.toEqual(preferences.getProjectPreference("b"));
  });

  it("Use default clears an override while Automatic remains explicit", () => {
    preferences.setProjectPreference("a", automaticPreference());
    expect(preferences.getProjectPreference("a")).toEqual(automaticPreference());
    preferences.setProjectPreference("a", inheritPreference());
    expect(preferences.getProjectPreference("a")).toEqual(inheritPreference());
  });

  it("migrates legacy values without inventing a generic remote target", () => {
    localStorage.setItem("canopy:placement:v1", JSON.stringify({
      global: "balance",
      projects: { inherited: "auto", automatic: "balance", local: "local", remote: "remote" },
      agents: { remote: "remote" },
    }));
    expect(preferences.getGlobalPreference()).toEqual(automaticPreference());
    expect(preferences.getProjectPreference("inherited")).toEqual(inheritPreference());
    expect(preferences.getProjectPreference("automatic")).toEqual(automaticPreference());
    expect(preferences.getProjectPreference("local")).toEqual(targetPreference({ kind: "local" }));
    expect(preferences.getProjectPreference("remote")).toEqual(inheritPreference());
    expect(preferences.getAgentPreference("remote")).toEqual(inheritPreference());
  });

  it("maps legacy global auto to Automatic and ignores corrupt values", () => {
    localStorage.setItem("canopy:placement:v1", JSON.stringify({ global: "auto" }));
    expect(preferences.getGlobalPreference()).toEqual(automaticPreference());
    localStorage.setItem("canopy:placement:v1", "{nope");
    expect(preferences.getGlobalPreference()).toEqual(automaticPreference());
    localStorage.setItem("canopy:placement:v1", JSON.stringify({ global: "x", projects: { a: "bogus" } }));
    expect(preferences.getProjectPreference("a")).toEqual(inheritPreference());
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import * as p from "./preferences";

describe("placement preferences", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to auto", () => {
    expect(p.getGlobalPreference()).toBe("auto");
    expect(p.getProjectPreference("a")).toBe("auto");
    expect(p.getAgentPreference("claude")).toBe("auto");
  });
  it("round-trips each level independently", () => {
    p.setGlobalPreference("balance");
    p.setProjectPreference("a", "remote");
    p.setAgentPreference("claude", "local");
    expect(p.getGlobalPreference()).toBe("balance");
    expect(p.getProjectPreference("a")).toBe("remote");
    expect(p.getProjectPreference("b")).toBe("auto");
    expect(p.getAgentPreference("claude")).toBe("local");
  });
  it("auto clears an override", () => {
    p.setProjectPreference("a", "remote");
    p.setProjectPreference("a", "auto");
    expect(p.getProjectPreference("a")).toBe("auto");
  });
  it("ignores corrupt storage and invalid values", () => {
    localStorage.setItem("canopy:placement:v1", "{nope");
    expect(p.getGlobalPreference()).toBe("auto");
    localStorage.setItem("canopy:placement:v1", JSON.stringify({ global: "x", projects: { a: "bogus", __proto__: "local" } }));
    expect(p.getGlobalPreference()).toBe("auto");
    expect(p.getProjectPreference("a")).toBe("auto");
  });
});

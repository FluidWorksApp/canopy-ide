import { describe, expect, it } from "vitest";
import { profileFromEnv, tabAccount, unresolvedLaunchAccount } from "./tabAccount";

const vjEnv: [string, string][] = [
  ["CANOPY_PROFILE", "vj"],
  ["CLAUDE_CONFIG_DIR", "/Users/dev/.canopy/profiles/vj/.claude"],
];

describe("a tab's account", () => {
  it("is the account its env names", () => {
    expect(profileFromEnv(vjEnv)).toBe("vj");
    expect(profileFromEnv([["PORT", "3000"]])).toBeNull();
    expect(profileFromEnv(undefined)).toBeNull();
    expect(tabAccount({ env: vjEnv, pending: null, cli: "claude", requested: undefined })).toBe("vj");
  });

  /** The restored-tab bug: env carried VJ, the tab recorded nothing, and the
   *  plan chip read Default's numbers. */
  it("comes from the env even when the caller passed no account", () => {
    expect(tabAccount({ env: [["PORT", "1"], ...vjEnv], pending: null, cli: "claude", requested: undefined })).toBe("vj");
  });

  it("does not claim an account the CLI was not given", () => {
    expect(tabAccount({ env: [], pending: null, cli: "claude", requested: "vj" })).toBeUndefined();
    // A plain shell has no env to contradict its label.
    expect(tabAccount({ env: [], pending: null, cli: null, requested: "vj" })).toBe("vj");
  });

  it("names a pending account while its env resolves", () => {
    expect(tabAccount({ env: [], pending: "vj", cli: "claude", requested: undefined })).toBe("vj");
  });
});

describe("a launch before the env is primed", () => {
  const base = { cli: "claude", extraEnv: undefined, profile: undefined, syncEnv: [] as [string, string][], active: "vj" };

  /** Start-up: launching anyway put the agent on the Default login. */
  it("waits for a named account instead of falling back to Default", () => {
    expect(unresolvedLaunchAccount(base)).toBe("vj");
  });

  it("is resolved when the env is primed, passed, or the account is Default", () => {
    expect(unresolvedLaunchAccount({ ...base, syncEnv: vjEnv })).toBeNull();
    expect(unresolvedLaunchAccount({ ...base, extraEnv: [] })).toBeNull();
    expect(unresolvedLaunchAccount({ ...base, profile: "default" })).toBeNull();
    expect(unresolvedLaunchAccount({ ...base, active: "default" })).toBeNull();
  });

  it("never waits for a CLI that cannot hold an account", () => {
    expect(unresolvedLaunchAccount({ ...base, cli: "agy" })).toBeNull();
    expect(unresolvedLaunchAccount({ ...base, cli: null })).toBeNull();
  });
});

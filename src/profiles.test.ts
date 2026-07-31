import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILE,
  activeProfile,
  launchEnv,
  launchEnvSync,
  launchProfile,
  primeLaunchEnv,
  PROFILE_CAPABLE,
  profileLabel,
  setActiveProfile,
  supportsProfiles,
} from "./profiles";
import { getSettings } from "./settings";
import type { AgentProfile } from "./ipc";
import * as ipc from "./ipc";
import profilesRs from "../src-tauri/src/profiles.rs?raw";

vi.mock("./ipc", () => ({ profileEnv: vi.fn(), profileActivate: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ipc.profileEnv).mockReset();
  vi.mocked(ipc.profileActivate).mockResolvedValue(undefined);
});

const profiles: AgentProfile[] = [
  { id: "default", label: "Default", root: "/Users/dev", removable: false },
  {
    id: "work",
    label: "Work",
    root: "/Users/dev/.canopy/profiles/work",
    removable: true,
  },
];

describe("the active account", () => {
  it("is the login the machine already had, until switched", () => {
    expect(activeProfile()).toBe(DEFAULT_PROFILE);
    expect(getSettings().activeProfile).toBe(DEFAULT_PROFILE);
  });

  it("moves every CLI at once", () => {
    setActiveProfile("work");
    expect(activeProfile()).toBe("work");
  });

  it("goes back to the default account", () => {
    setActiveProfile("work");
    setActiveProfile(DEFAULT_PROFILE);
    expect(activeProfile()).toBe(DEFAULT_PROFILE);
  });

  it("announces a change so the chip and launchers re-read", () => {
    const seen: string[] = [];
    const onChange = () => seen.push(activeProfile());
    window.addEventListener("canopy:cli-profile-changed", onChange);
    setActiveProfile("work");
    window.removeEventListener("canopy:cli-profile-changed", onChange);
    expect(seen).toEqual(["work"]);
  });
});

describe("labels", () => {
  it("names an account the way the user named it", () => {
    expect(profileLabel(profiles, "work")).toBe("Work");
  });

  /** A tab can outlive the account it names. */
  it("falls back to the id for an account that is gone", () => {
    expect(profileLabel(profiles, "vanished")).toBe("vanished");
  });
});

describe("launchEnv", () => {
  it("asks for nothing at all on the default profile", async () => {
    expect(await launchEnv("claude")).toEqual([]);
    // Not "asked and got an empty answer" — the default must not even take the
    // code path, so a launch stays exactly what it was before profiles existed.
    expect(ipc.profileEnv).not.toHaveBeenCalled();
  });

  it("resolves the CLI's config-home variable from Rust", async () => {
    vi.mocked(ipc.profileEnv).mockResolvedValue([
      ["CANOPY_PROFILE", "work"],
      ["CLAUDE_CONFIG_DIR", "/Users/dev/.canopy/profiles/work/.claude"],
    ]);
    setActiveProfile("work");
    expect(await launchEnv("claude")).toEqual([
      ["CANOPY_PROFILE", "work"],
      ["CLAUDE_CONFIG_DIR", "/Users/dev/.canopy/profiles/work/.claude"],
    ]);
    expect(ipc.profileEnv).toHaveBeenCalledWith("claude", "work");
  });

  it("still launches when the lookup fails", async () => {
    vi.mocked(ipc.profileEnv).mockRejectedValue(new Error("no home dir"));
    setActiveProfile("work");
    expect(await launchEnv("claude")).toEqual([]);
  });

  it("leaves CLIs with no config-home variable on their single account", async () => {
    setActiveProfile("work");
    expect(await launchEnv("agy")).toEqual([]);
    expect(ipc.profileEnv).not.toHaveBeenCalled();
  });
});

describe("the synchronous launch path", () => {
  it("serves the primed account env without awaiting", async () => {
    vi.mocked(ipc.profileEnv).mockImplementation(async (agent: string) =>
      agent === "claude"
        ? ([["CLAUDE_CONFIG_DIR", "/p/vj/.claude"]] as [string, string][])
        : [],
    );
    setActiveProfile("vj");
    await primeLaunchEnv();
    expect(launchEnvSync("claude")).toEqual([
      ["CLAUDE_CONFIG_DIR", "/p/vj/.claude"],
    ]);
    expect(launchProfile("claude")).toBe("vj");
  });

  it("is empty on the default account, primed or not", async () => {
    await primeLaunchEnv();
    expect(launchEnvSync("claude")).toEqual([]);
    // Null, not "default": a tab badge must only ever claim an account that is
    // genuinely isolating the session.
    expect(launchProfile("claude")).toBeNull();
  });

  /** Serving the previous account would launch on the wrong login. */
  it("refuses to serve a stale account after a switch", async () => {
    vi.mocked(ipc.profileEnv).mockResolvedValue([
      ["CLAUDE_CONFIG_DIR", "/p/vj/.claude"],
    ]);
    setActiveProfile("vj");
    await primeLaunchEnv();
    setActiveProfile("personal"); // primed cache now belongs to the old account
    expect(launchEnvSync("claude")).toEqual([]);
    expect(launchProfile("claude")).toBeNull();
  });

  it("never claims an account for a CLI that cannot hold one", async () => {
    vi.mocked(ipc.profileEnv).mockResolvedValue([]);
    setActiveProfile("vj");
    await primeLaunchEnv();
    expect(launchEnvSync("agy")).toEqual([]);
    expect(launchProfile("agy")).toBeNull();
  });
});

describe("capability", () => {
  it("claims only the CLIs with a config-home variable", () => {
    expect(["claude", "codex", "opencode", "amp"].every(supportsProfiles)).toBe(
      true,
    );
    expect(["agy", "omp", "aider", "gemini"].some(supportsProfiles)).toBe(false);
  });

  /** Rust owns the env mapping; this list only mirrors it so pickers can
   *  render without awaiting. Drift either way is invisible to the user. */
  it("matches PROFILE_AGENTS in profiles.rs", () => {
    const rust = profilesRs.slice(profilesRs.indexOf("PROFILE_AGENTS"));
    const listed = [
      ...rust.slice(0, rust.indexOf(";")).matchAll(/"([a-z-]+)"/g),
    ].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    expect([...PROFILE_CAPABLE].sort()).toEqual(listed.sort());
  });
});

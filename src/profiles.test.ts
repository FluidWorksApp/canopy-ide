import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILE,
  activeProfile,
  launchEnv,
  profileBadge,
  profileLabel,
  setActiveProfile,
  supportsProfiles,
} from "./profiles";
import { getSettings } from "./settings";
import type { AgentProfile } from "./ipc";
import * as ipc from "./ipc";

vi.mock("./ipc", () => ({ profileEnv: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ipc.profileEnv).mockReset();
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

describe("selection", () => {
  it("is the default login until something says otherwise", () => {
    expect(activeProfile("claude")).toBe(DEFAULT_PROFILE);
    expect(getSettings().cliProfiles).toEqual({});
  });

  it("remembers a choice per CLI, not globally", () => {
    setActiveProfile("claude", "work");
    expect(activeProfile("claude")).toBe("work");
    // Switching one CLI's account must not move another's — they are separate
    // subscriptions and often separate people's.
    expect(activeProfile("codex")).toBe(DEFAULT_PROFILE);
  });

  /** The stored map is a list of exceptions. Writing "default" into it would be
   *  a second way to say the same thing, and the first upgrade that renames the
   *  default profile would then have two truths to reconcile. */
  it("stores nothing when the default is chosen", () => {
    setActiveProfile("claude", "work");
    setActiveProfile("claude", DEFAULT_PROFILE);
    expect(getSettings().cliProfiles).toEqual({});
    expect(activeProfile("claude")).toBe(DEFAULT_PROFILE);
  });

  it("announces a change so open launchers re-render", () => {
    const seen: string[] = [];
    const onChange = () => seen.push(activeProfile("claude"));
    window.addEventListener("canopy:cli-profile-changed", onChange);
    setActiveProfile("claude", "work");
    window.removeEventListener("canopy:cli-profile-changed", onChange);
    expect(seen).toEqual(["work"]);
  });
});

describe("labels", () => {
  it("badges a real account and stays quiet about the default", () => {
    expect(profileBadge(profiles, "work")).toBe("Work");
    // Every tab would carry it, so it would be decoration rather than a signal.
    expect(profileBadge(profiles, DEFAULT_PROFILE)).toBeNull();
    expect(profileBadge(profiles, "")).toBeNull();
  });

  /** A selection can outlive the profile it names (removed in Settings while a
   *  CLI still points at it). Rendering the id keeps the row actionable instead
   *  of showing blank space the user cannot reason about. */
  it("falls back to the id for a profile that is gone", () => {
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
    setActiveProfile("claude", "work");
    expect(await launchEnv("claude")).toEqual([
      ["CANOPY_PROFILE", "work"],
      ["CLAUDE_CONFIG_DIR", "/Users/dev/.canopy/profiles/work/.claude"],
    ]);
    expect(ipc.profileEnv).toHaveBeenCalledWith("claude", "work");
  });

  /** A profile lookup is not worth failing a launch over: starting on the
   *  default login is visible in the tab badge and recoverable, whereas not
   *  starting is neither. */
  it("still launches when the lookup fails", async () => {
    vi.mocked(ipc.profileEnv).mockRejectedValue(new Error("no home dir"));
    setActiveProfile("claude", "work");
    expect(await launchEnv("claude")).toEqual([]);
  });
});

describe("capability", () => {
  /** Mirrors PROFILE_AGENTS in profiles.rs. A wrong "yes" here is the one
   *  failure a user cannot see: two accounts quietly sharing one login. */
  it("claims only the CLIs with a config-home variable", () => {
    expect(["claude", "codex", "opencode", "amp"].every(supportsProfiles)).toBe(
      true,
    );
    expect(["agy", "omp", "aider", "gemini"].some(supportsProfiles)).toBe(false);
  });
});

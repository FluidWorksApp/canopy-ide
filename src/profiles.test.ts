import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILE,
  activeProfile,
  launchEnv,
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

describe("the active account", () => {
  it("is the login the machine already had, until switched", () => {
    expect(activeProfile()).toBe(DEFAULT_PROFILE);
    expect(getSettings().activeProfile).toBe(DEFAULT_PROFILE);
  });

  /** One switch, not one per CLI: "who am I working as" is a single question,
   *  and answering it seven times is how the state stops being legible. */
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

  /** A tab can outlive the account it names (removed in Settings while its
   *  session is still open). Rendering the id keeps the badge meaningful
   *  instead of showing blank space the user cannot reason about. */
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

  /** A profile lookup is not worth failing a launch over: starting on the
   *  default login is visible in the tab badge and recoverable, whereas not
   *  starting is neither. */
  it("still launches when the lookup fails", async () => {
    vi.mocked(ipc.profileEnv).mockRejectedValue(new Error("no home dir"));
    setActiveProfile("work");
    expect(await launchEnv("claude")).toEqual([]);
  });

  /** A CLI that can't hold a second login keeps the one account it has, even
   *  while the rest of the app is switched — anything else would imply an
   *  isolation that isn't happening. */
  it("leaves CLIs with no config-home variable on their single account", async () => {
    setActiveProfile("work");
    expect(await launchEnv("agy")).toEqual([]);
    expect(ipc.profileEnv).not.toHaveBeenCalled();
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

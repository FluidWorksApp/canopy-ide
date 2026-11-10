import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  profileActivate: vi.fn(async () => {}),
  profileEnv: vi.fn(async (cli: string, profile: string) => [["CONFIG_DIR", `/p/${profile}/${cli}`]]),
}));
vi.mock("./projects", () => ({
  agentCliFor: (id: string) => (id === "codex" || id === "claude" ? { id, capabilities: { profiles: true } } : { id }),
  agentClisWith: () => [{ id: "claude" }, { id: "codex" }],
}));

import { getSettings, updateSettings } from "./settings";
import { DEFAULT_PROFILE, lastProfileFor, launchEnvFor, launchableProfiles, rememberProfile } from "./profiles";

const profiles = [
  { id: "default", label: "Default", root: "~", removable: false },
  { id: "work", label: "Work", root: "/p/work", removable: true },
];

beforeEach(() => {
  localStorage.clear();
  updateSettings({ activeProfile: DEFAULT_PROFILE, lastProfileByCli: {} });
});

describe("per-agent account", () => {
  it("defaults to the active account until an agent has been launched", () => {
    expect(lastProfileFor("codex")).toBe("default");
    updateSettings({ activeProfile: "work" });
    expect(lastProfileFor("codex")).toBe("work");
  });

  it("remembers the account each agent was last launched under, separately", () => {
    rememberProfile("codex", "work");
    expect(lastProfileFor("codex")).toBe("work");
    expect(lastProfileFor("claude")).toBe("default");
    expect(getSettings().lastProfileByCli).toEqual({ codex: "work" });
  });

  it("falls back when the remembered account no longer exists", () => {
    rememberProfile("codex", "gone");
    expect(lastProfileFor("codex", ["default", "work"])).toBe("default");
    expect(lastProfileFor("codex", ["default", "gone"])).toBe("gone");
  });

  it("offers a choice only for an agent that can hold accounts and has several", () => {
    expect(launchableProfiles(profiles, "codex")).toHaveLength(2);
    expect(launchableProfiles(profiles, "amp")).toEqual([]);
    expect(launchableProfiles([profiles[0]], "codex")).toEqual([]);
  });

  it("builds the env for a chosen account, and none for the default", async () => {
    expect(await launchEnvFor("codex", "work")).toEqual([["CONFIG_DIR", "/p/work/codex"]]);
    expect(await launchEnvFor("codex", "default")).toEqual([]);
    expect(await launchEnvFor("amp", "work")).toEqual([]);
  });
});

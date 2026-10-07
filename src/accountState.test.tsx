import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import type { AccountStatus, AgentProfile } from "./ipc";
import * as ipc from "./ipc";
import { accountSummary, cliLogin, cliLoginText, signedInClis, syncNotice } from "./accountState";
import { agentCliFor } from "./projects";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  profilesList: vi.fn(),
  profileAccounts: vi.fn(),
  profileActivate: vi.fn(async () => {}),
}));

import { AccountSwitcher } from "./components/StatusBar";
import { AgentAccounts } from "./components/SettingsDialog";
import { AccountSync } from "./remoteExecution/AccountSync";

const profiles: AgentProfile[] = [
  { id: "default", label: "Default", root: "/Users/dev", removable: false },
  { id: "vj", label: "VJ", root: "/Users/dev/.canopy/profiles/vj", removable: true },
];
// The reported state: Default's Claude was cleared by a failed renewal but its
// `.claude.json` still names the account; VJ holds both logins.
const accounts: Record<string, AccountStatus[]> = {
  default: [
    { agent: "claude", state: "out", account: "old@example.com", reason: "signed-out" },
    { agent: "codex", state: "in", account: null, reason: null },
    { agent: "opencode", state: "unknown", account: null, reason: null },
  ],
  vj: [
    { agent: "claude", state: "in", account: "vj@example.com", reason: null },
    { agent: "codex", state: "in", account: null, reason: null },
    { agent: "opencode", state: "unknown", account: null, reason: null },
  ],
};
const expected: Record<string, string[]> = { default: ["codex"], vj: ["claude", "codex"] };
const name = (agent: string) => agentCliFor(agent)?.name ?? agent;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(ipc.profilesList).mockResolvedValue(profiles);
  vi.mocked(ipc.profileAccounts).mockImplementation(async (id: string) => accounts[id] ?? []);
  mocks.invoke.mockImplementation(async (command: string, args?: { id?: string }) => {
    if (command === "profiles_list") return profiles;
    if (command === "profile_accounts") return accounts[args?.id ?? ""] ?? [];
    if (command === "execution_remote_account_candidates")
      return [
        { id: "default", claude: "incomplete", codex: "ready" },
        { id: "vj", claude: "ready", codex: "ready" },
      ];
    return null;
  });
});

describe("one reading of who is signed in", () => {
  it("never counts a recorded account whose login was cleared", () => {
    expect(signedInClis(accounts.default)).toEqual(["codex"]);
    expect(cliLogin(accounts.default[0])).toBe("signed-out");
    expect(cliLoginText(accounts.default[0], "Claude Code").text).toBe(
      "signed out (was old@example.com)",
    );
    expect(accountSummary([accounts.default[0]])).toBe("signed out of claude");
    expect(accountSummary(undefined)).toBe("no logins yet");
  });

  it("marks a login the store could not check", () => {
    const row: AccountStatus = { agent: "claude", state: "in", account: "a@b.c", reason: "unverified" };
    expect(signedInClis([row])).toEqual(["claude"]);
    expect(cliLoginText(row, "Claude Code").text).toContain("unverified");
  });

  it("reads an older host's rows (no reason) the same way", () => {
    expect(signedInClis([{ agent: "codex", state: "in", account: null }])).toEqual(["codex"]);
  });
});

describe("the switcher, Settings and the remote panel agree", () => {
  it("lists the same signed-in CLIs per account for the same inputs", async () => {
    // Status-bar switcher.
    const switcher = render(<AccountSwitcher />);
    fireEvent.click(await screen.findByTitle(/click to switch/));
    const fromSwitcher: Record<string, string[]> = {};
    await waitFor(() => {
      for (const row of switcher.container.querySelectorAll(".status-account-row")) {
        const label = row.querySelector(".status-account-label")!.textContent!.replace("✓ ", "");
        const held = row.querySelector(".status-account-held")!.textContent!;
        fromSwitcher[label === "Default" ? "default" : "vj"] = held.includes("signed out") || held.includes("no logins")
          ? [] : held.split(", ");
      }
      expect(fromSwitcher).toEqual(expected);
    });
    switcher.unmount();

    // Settings → Accounts, every row unfolded.
    const settings = render(<AgentAccounts onRunInTerminal={() => {}} />);
    for (const label of ["Default", "VJ"]) fireEvent.click(await screen.findByText(label));
    const fromSettings: Record<string, string[]> = {};
    await waitFor(() => {
      for (const row of settings.container.querySelectorAll(".cli-account-row")) {
        const label = row.querySelector(".cli-account-name")!.textContent!;
        fromSettings[label === "Default" ? "default" : "vj"] = [...row.querySelectorAll(".cli-account-cli")]
          .filter((cli) => !cli.querySelector(".cli-account-who-out"))
          .map((cli) => cli.querySelector(".cli-account-cli-name")!.textContent!)
          .map((n) => ["claude", "codex", "opencode", "amp"].find((id) => name(id) === n)!);
      }
      expect(fromSettings).toEqual(expected);
    });
    expect(within(settings.container).getByText("signed out (was old@example.com)")).toBeTruthy();
    settings.unmount();

    // Remote panel: the workspace holds the same rows.
    const remote = render(<AccountSync workspaceName="Cloud" />);
    const fromRemote: Record<string, string[]> = {};
    await waitFor(() => {
      for (const row of remote.container.querySelectorAll(".account-sync-row")) {
        const text = row.textContent ?? "";
        const state = row.querySelector(".account-sync-state")!.textContent!;
        const ready = state.startsWith("Ready · ") ? state.slice(8).split(" (")[0].split(", ") : [];
        fromRemote[text.includes("VJ") ? "vj" : "default"] = ready.map(
          (n) => ["claude", "codex"].find((id) => name(id) === n)!,
        );
      }
      expect(fromRemote).toEqual(expected);
    });
    // The Mac's own Default Claude is reported as signed out here, not ready.
    expect(remote.container.textContent).toContain("signed out on this Mac (was old@example.com)");
  });
});

describe("the sync notice", () => {
  it("names what reached the workspace and what an older host kept", () => {
    const notice = syncNotice(
      {
        imported: ["codex"],
        sent: { default: ["codex"], vj: ["claude", "codex"] },
        notUpdated: ["VJ"],
        incomplete: ["Default (Claude)"],
      },
      profiles,
    );
    expect(notice).toContain(`Synced Default (${name("codex")}).`);
    expect(notice).toContain("Not updated: VJ.");
    expect(notice).not.toContain("Synced Default, VJ");
    expect(notice).toContain("Default (Claude)");
  });
});

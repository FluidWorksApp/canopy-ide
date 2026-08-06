import { describe, expect, it } from "vitest";
import {
  envReachesProfile,
  reloadPlan,
  reloading,
  reloadSummary,
  type OpenAgent,
} from "./accountSwitch";
import type { AccountStatus, SessionDigest } from "./ipc";
import type { Restorable } from "./restorable";

const open = (over: Partial<OpenAgent> = {}): OpenAgent => ({
  tabId: "t1",
  agentId: "claude",
  cwd: "/repo",
  label: "Claude Code",
  ...over,
});

const signedIn = (agent: string): AccountStatus => ({
  agent,
  state: "in",
  account: `${agent}@example.com`,
});

const restorable = (over: Partial<Restorable> = {}): Restorable => ({
  digest: { session_id: "s-1", updated: 100 } as SessionDigest,
  agentId: "claude",
  cwd: "/repo",
  command: "claude --resume s-1",
  prompt: "fix the thing",
  profile: "work",
  superseded: [],
  ...over,
});

describe("reloadPlan", () => {
  it("reopens the account's own session in that directory", () => {
    const [item] = reloadPlan({
      open: [open()],
      accounts: [signedIn("claude")],
      restorables: [restorable()],
      profile: "work",
    });
    expect(item.action).toEqual({
      kind: "resume",
      command: "claude --resume s-1",
      cwd: "/repo",
      sessionId: "s-1",
    });
  });

  /** The whole reason a conversation can't come along: it lives inside the
   *  config dir of the account that made it. */
  it("never carries another account's session across", () => {
    const [item] = reloadPlan({
      open: [open()],
      accounts: [signedIn("claude")],
      restorables: [restorable({ profile: "default" })],
      profile: "work",
    });
    expect(item.action).toEqual({ kind: "fresh" });
  });

  it("starts fresh when the account has nothing here yet", () => {
    const [item] = reloadPlan({
      open: [open()],
      accounts: [signedIn("claude")],
      restorables: [restorable({ cwd: "/elsewhere" })],
      profile: "work",
    });
    expect(item.action).toEqual({ kind: "fresh" });
  });

  it("takes the newest of that account's sessions here", () => {
    const [item] = reloadPlan({
      open: [open()],
      accounts: [signedIn("claude")],
      restorables: [
        restorable({
          digest: { session_id: "old", updated: 100 } as SessionDigest,
          command: "claude --resume old",
        }),
        restorable({
          digest: { session_id: "new", updated: 900 } as SessionDigest,
          command: "claude --resume new",
        }),
      ],
      profile: "work",
    });
    expect(item.action).toMatchObject({ sessionId: "new" });
  });

  /** Killing a working agent to land it at a login prompt is worse than
   *  leaving it on the account it is already using. */
  it("leaves an agent alone when the account has no login for it", () => {
    const plan = reloadPlan({
      open: [open({ agentId: "codex", tabId: "t2" })],
      accounts: [signedIn("claude"), { agent: "codex", state: "out", account: null }],
      restorables: [],
      profile: "work",
    });
    expect(plan[0]).toMatchObject({ action: null, reason: "not-signed-in" });
    expect(reloading(plan)).toHaveLength(0);
  });

  it("treats an unreadable sign-in state as not signed in", () => {
    const [item] = reloadPlan({
      open: [open({ agentId: "amp" })],
      accounts: [{ agent: "amp", state: "unknown", account: null }],
      restorables: [],
      profile: "work",
    });
    expect(item).toMatchObject({ action: null, reason: "not-signed-in" });
  });

  it("leaves CLIs that cannot hold a second login alone", () => {
    const [item] = reloadPlan({
      open: [open({ agentId: "agy" })],
      accounts: [signedIn("agy")], // even if something claimed otherwise
      restorables: [],
      profile: "work",
    });
    expect(item).toMatchObject({ action: null, reason: "single-account" });
  });

  it("decides per agent, not per switch", () => {
    const plan = reloadPlan({
      open: [
        open({ tabId: "a", agentId: "claude" }),
        open({ tabId: "b", agentId: "codex" }),
        open({ tabId: "c", agentId: "aider" }),
      ],
      accounts: [signedIn("claude"), { agent: "codex", state: "out", account: null }],
      restorables: [restorable()],
      profile: "work",
    });
    expect(plan.map((p) => p.action?.kind ?? p.reason)).toEqual([
      "resume",
      "not-signed-in",
      "single-account",
    ]);
    expect(reloading(plan).map((p) => p.agent.tabId)).toEqual(["a"]);
  });
});

describe("envReachesProfile", () => {
  /** Switching back to the default account resolves an empty env for every
   *  CLI — that is its normal state, not a failed lookup, and treating it as
   *  failure made "Reload as Default" a silent no-op. */
  it("lets the default account through with no env", () => {
    expect(envReachesProfile("default", [])).toBe(true);
  });

  it("treats an empty env on a named account as a failed lookup", () => {
    expect(envReachesProfile("work", [])).toBe(false);
    expect(envReachesProfile("work", [["CLAUDE_CONFIG_DIR", "/x"]])).toBe(true);
  });
});

describe("reloadSummary", () => {
  it("says what will happen to each agent", () => {
    const plan = reloadPlan({
      open: [
        open({ tabId: "a" }),
        open({ tabId: "b", agentId: "codex" }),
        open({ tabId: "c", agentId: "agy" }),
      ],
      accounts: [signedIn("claude"), { agent: "codex", state: "out", account: null }],
      restorables: [],
      profile: "work",
    });
    expect(plan.map(reloadSummary)).toEqual([
      "starts fresh here",
      "no login in this account — left as is",
      "can't hold a second login — left as is",
    ]);
  });
});

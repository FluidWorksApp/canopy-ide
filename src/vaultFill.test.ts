import { describe, expect, it, vi } from "vitest";
import {
  ALLOW_ALWAYS,
  ALLOW_ONCE,
  DENY,
  approvalPrompt,
  gate,
  hostOf,
  runVaultOp,
} from "./vaultFill";
import { mockCommands } from "./test/setup";

const ctx = (
  answer: string,
  preview: { tabId: string; url: string } | null = {
    tabId: "t1",
    url: "https://github.com/login",
  },
) => ({
  preview: async () => preview,
  ask: vi.fn(async () => answer),
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: "v1",
  label: "GitHub",
  domain: "github.com",
  username: "sam",
  readable: false,
  notes: "",
  updated: 1,
  ...over,
});

describe("the approval gate", () => {
  it("asks once per domain, then stops asking", async () => {
    const c = ctx(ALLOW_ALWAYS);
    const first = await gate("fill", "GitHub", "github.com", "github.com", c, []);
    expect(first).toEqual({ go: true, remember: true });
    expect(c.ask).toHaveBeenCalledOnce();

    const c2 = ctx(DENY);
    const later = await gate("fill", "GitHub", "github.com", "github.com", c2, [
      { domain: "github.com", fill: true, read: false, granted: 1 },
    ]);
    expect(later.go).toBe(true);
    expect(c2.ask).not.toHaveBeenCalled();
  });

  it("treats one-off approval as one-off", async () => {
    const c = ctx(ALLOW_ONCE);
    expect(await gate("fill", "GitHub", "github.com", "github.com", c, [])).toEqual({
      go: true,
      remember: false,
    });
  });

  it("treats anything that is not a yes as a no", async () => {
    for (const answer of [
      DENY,
      "(the user skipped this question — decide for yourself)",
      "maybe later",
      "",
      "yes", // not one of the offered options: a credential prompt takes no guesses
    ]) {
      const c = ctx(answer);
      const out = await gate("fill", "GitHub", "github.com", "github.com", c, []);
      expect(out.go, `answer: ${answer}`).toBe(false);
    }
  });

  it("keeps fill approval and read approval apart", async () => {
    // Letting an agent sign in is not letting it read the password back.
    const approvals = [{ domain: "github.com", fill: true, read: false, granted: 1 }];
    const c = ctx(DENY);
    const out = await gate("read", "GitHub", "github.com", "github.com", c, approvals);
    expect(c.ask).toHaveBeenCalledOnce();
    expect(out.go).toBe(false);
  });

  it("names the site and the entry, and never the secret", () => {
    const fill = approvalPrompt("fill", "GitHub", "github.com");
    expect(fill).toContain("GitHub");
    expect(fill).toContain("github.com");
    expect(fill).toContain("never sees the password");
    expect(approvalPrompt("read", "GitHub", "github.com")).toContain("plain text");
  });
});

describe("hostOf", () => {
  it("reads the host the way the backend does", () => {
    expect(hostOf("https://gist.github.com/x")).toBe("gist.github.com");
    expect(hostOf("http://localhost:5173/")).toBe("localhost");
    expect(hostOf("not a url")).toBe("");
  });
});

describe("runVaultOp", () => {
  it("sends ids to the backend and gets back no password", async () => {
    const filled: unknown[] = [];
    mockCommands({
      vault_status: () => ({ exists: true, unlocked: true, entries: 1, auto_lock_minutes: 30 }),
      vault_matches: () => [entry()],
      vault_approvals: () => [{ domain: "github.com", fill: true, read: false, granted: 1 }],
      vault_fill: (args: unknown) => {
        filled.push(args);
        return { filled: ["username", "password"], label: "GitHub", domain: "github.com", form: true };
      },
    });
    const out = (await runVaultOp({ vaultOp: "fill" }, ctx(DENY))) as Record<string, unknown>;
    // The call carries a tab and an entry id — nothing else could carry a secret.
    expect(filled).toEqual([{ tabId: "t1", id: "v1" }]);
    expect(out.filled).toEqual(["username", "password"]);
    expect(JSON.stringify(out)).not.toContain("password:");
  });

  it("says what to do when the vault is locked or missing", async () => {
    mockCommands({
      vault_status: () => ({ exists: true, unlocked: false, entries: 0, auto_lock_minutes: 30 }),
    });
    await expect(runVaultOp({ vaultOp: "fill" }, ctx(ALLOW_ALWAYS))).rejects.toThrow(
      /locked/,
    );
    mockCommands({
      vault_status: () => ({ exists: false, unlocked: false, entries: 0, auto_lock_minutes: 30 }),
    });
    await expect(runVaultOp({ vaultOp: "list" }, ctx(ALLOW_ALWAYS))).rejects.toThrow(
      /no credential vault/,
    );
  });

  it("refuses to fill with no page open, and to invent an entry", async () => {
    mockCommands({
      vault_status: () => ({ exists: true, unlocked: true, entries: 1, auto_lock_minutes: 30 }),
      vault_matches: () => [],
      vault_list: () => [entry()],
      vault_approvals: () => [],
    });
    await expect(
      runVaultOp({ vaultOp: "fill" }, ctx(ALLOW_ALWAYS, null)),
    ).rejects.toThrow(/no preview tab/);
    await expect(runVaultOp({ vaultOp: "fill" }, ctx(ALLOW_ALWAYS))).rejects.toThrow(
      /no vault entry for github.com/,
    );
  });

  it("does not fill when the user says no", async () => {
    let filledCalls = 0;
    mockCommands({
      vault_status: () => ({ exists: true, unlocked: true, entries: 1, auto_lock_minutes: 30 }),
      vault_matches: () => [entry()],
      vault_approvals: () => [],
      vault_fill: () => {
        filledCalls += 1;
        return { filled: [], label: "", domain: "", form: false };
      },
    });
    await expect(runVaultOp({ vaultOp: "fill" }, ctx(DENY))).rejects.toThrow(/declined/);
    expect(filledCalls).toBe(0);
  });

  it("lists only what matches the open page, without passwords", async () => {
    mockCommands({
      vault_status: () => ({ exists: true, unlocked: true, entries: 2, auto_lock_minutes: 30 }),
      vault_matches: () => [entry()],
      vault_list: () => [entry(), entry({ id: "v2", label: "Other", domain: "example.com" })],
    });
    const out = (await runVaultOp({ vaultOp: "list" }, ctx(DENY))) as {
      entries: Record<string, unknown>[];
    };
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).not.toHaveProperty("password");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onTurnEnd, resetReceiptEngineForTests, scheduleVerify, setReceiptEngineDepsForTests, verifyTurn, type VerifyTarget } from "./engine";
import { receiptFor, resetReceiptsForTests, latestReceiptFor } from "./store";
import { updateSettings } from "../settings";
import type { ReceiptCheckRun } from "../ipc";
import type { ReceiptData } from "./types";

const ok = (stdout: string, code: number | null = 0, extra: Partial<ReceiptCheckRun> = {}): ReceiptCheckRun => ({
  code,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  durationMs: 1234,
  spawnError: null,
  ...extra,
});

const PATCH = `diff --git a/src/sum.test.ts b/src/sum.test.ts
--- a/src/sum.test.ts
+++ b/src/sum.test.ts
@@ -1 +1 @@
-  expect(sum(1, 2)).toBe(3);
+  expect(sum(1, 2)).toBeTruthy();
diff --git a/src/sum.ts b/src/sum.ts
--- a/src/sum.ts
+++ b/src/sum.ts
@@ -1 +1 @@
-a - b
+a + b
`;

function fakeRun(opts: { testOut?: ReceiptCheckRun; changed?: string; patch?: string } = {}) {
  return vi.fn(async (_cwd: string, argv: string[]): Promise<ReceiptCheckRun> => {
    const cmd = argv.join(" ");
    if (cmd === "git rev-parse --show-toplevel") return ok("/repo\n");
    if (cmd === "git branch --show-current") return ok("feat/sum\n");
    if (cmd.startsWith("git ls-files")) return ok("");
    if (cmd.startsWith("git diff --name-only")) return ok(opts.changed ?? "src/sum.ts\nsrc/sum.test.ts\npackage.json\n");
    if (cmd.startsWith("git diff --no-color")) return ok(opts.patch ?? PATCH);
    if (cmd === "git show snap123:package.json") return ok(JSON.stringify({ dependencies: { react: "1" } }));
    if (argv[0] === "curl") return ok("404");
    if (argv[0] === "/bin/sh") return opts.testOut ?? ok(" Test Files  1 passed (1)\n      Tests  4 passed (4)\n");
    return ok("", 1);
  });
}

const target: VerifyTarget = {
  sessionId: "s1",
  ptyId: 7,
  cli: "agent-x",
  cwd: "/repo",
  root: "/repo",
  prompt: "Fix the sum bug",
  claim: "Fixed, all tests pass.",
  filesTouched: ["src/sum.ts", "src/sum.test.ts"],
  startedAt: 1000,
  endedAt: 5000,
};

let appended: ReceiptData[] = [];
const askBrain = vi.fn();

beforeEach(() => {
  resetReceiptsForTests();
  resetReceiptEngineForTests();
  appended = [];
  askBrain.mockReset();
  updateSettings({ receiptMode: "auto", receiptCommands: { "/repo": ["npm test -- --run"] } });
  setReceiptEngineDepsForTests({
    run: fakeRun(),
    readText: async (path) => {
      if (path === "/repo/package.json") return JSON.stringify({ dependencies: { react: "1", "left-padz": "1" } });
      throw new Error("no file");
    },
    turnList: (async () => ({ git: true, root: "/repo", shared: false, peers: [], restores: [], turns: [{ n: 1, start: { ref: "r", commit: "snap123", tree: "t", ts_ms: 1100 }, end: null, prompt: null, late: false, native_uuid: null }] })) as never,
    askBrain: askBrain as never,
    append: async (root, data) => {
      appended.push(data);
      return { id: `id${appended.length}`, ts: 9000 + appended.length, root, kind: "receipt", author: { kind: "workspace", name: "receipts" }, scope: "project", data };
    },
    platform: () => "unix",
    remote: () => false,
    now: () => 10_000,
  });
});
afterEach(() => {
  setReceiptEngineDepsForTests(null);
});

describe("verifyTurn", () => {
  it("runs the checks itself, flags the changed test and the unknown package, and asks the brain in the background", async () => {
    askBrain.mockResolvedValue({ ok: true, text: "", value: { verdict: "proven", asked: "Fix sum", did: "Changed - to +", evidence: ["4 tests passed"], gaps: [] }, costUsd: 0.004 });
    const r = await verifyTurn(target);
    expect(r).not.toBeNull();
    expect(askBrain).toHaveBeenCalledTimes(1);
    const req = askBrain.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "receipt", tier: "background", json: true, cwd: "/repo" });
    expect(req.prompt).toContain("Fix the sum bug");
    expect(req.prompt).toContain("Fixed, all tests pass.");
    expect(r!.base).toBe("turn start (snap123)");
    expect(r!.checks[0]).toMatchObject({ outcome: "passed", counts: { passed: 4 }, command: "npm test -- --run" });
    expect(r!.tamper.find((t) => t.path === "src/sum.test.ts")).toMatchObject({ severity: "review" });
    expect(r!.packages).toEqual([{ ecosystem: "npm", name: "left-padz", manifest: "package.json", status: "unknown" }]);
    // Brain said proven; the workspace says the test was rewritten and a
    // package is unknown — never proven.
    expect(r!.ceiling).toBe("partial");
    expect(r!.status).toBe("tests-changed");
    expect(r!.costUsd).toBe(0.004);
    expect(appended).toHaveLength(1);
    expect(receiptFor("s1")).toMatchObject({ state: "done" });
    expect(receiptFor(null, 7)).toMatchObject({ state: "done" });
    expect(latestReceiptFor({ branch: "feat/sum" })?.id).toBe("id1");
  });

  it("without a brain, passing checks reach partial and say why", async () => {
    setReceiptEngineDepsForTests({
      run: fakeRun({ changed: "src/sum.ts\n", patch: "" }),
      askBrain: (async () => ({ ok: false, reason: "no-brain", message: "x" })) as never,
      append: async (root, data) => ({ id: "x", ts: 1, root, kind: "receipt", author: { kind: "workspace", name: "receipts" }, scope: "project", data }),
      turnList: (async () => { throw new Error("remote"); }) as never,
      readText: async () => { throw new Error("none"); },
      platform: () => "unix",
      remote: () => false,
      now: () => 1,
    });
    const r = await verifyTurn({ ...target, filesTouched: ["src/sum.ts"] });
    expect(r!.base).toBe("HEAD");
    expect(r!.verdict).toBeNull();
    expect(r!.brainNote).toMatch(/No brain connected/);
    expect(r!.status).toBe("partial");
  });

  it("a failing suite is unproven whatever the brain says; a timeout is not a failure", async () => {
    askBrain.mockResolvedValue({ ok: true, text: "", value: { verdict: "proven", asked: "a", did: "d", evidence: [], gaps: [] }, costUsd: 0 });
    setReceiptEngineDepsForTests({ run: fakeRun({ testOut: ok("      Tests  1 failed | 3 passed (4)\n", 1), patch: "" }) });
    const failed = await verifyTurn({ ...target, filesTouched: ["src/sum.ts"] });
    expect(failed!.status).toBe("unproven");
    setReceiptEngineDepsForTests({ run: fakeRun({ testOut: ok("", null, { timedOut: true, durationMs: 600000 }), patch: "" }) });
    const slow = await verifyTurn({ ...target, sessionId: "s2", filesTouched: ["src/sum.ts"] });
    expect(slow!.checks[0].outcome).toBe("timed-out");
    expect(slow!.status).toBe("partial");
  });

  it("diffs the turn's start and end snapshots, so files made through a shell count too", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    const run = vi.fn(async (_cwd: string, argv: string[]): Promise<ReceiptCheckRun> => {
      const cmd = argv.join(" ");
      if (cmd === "git rev-parse --show-toplevel") return ok("/repo\n");
      if (cmd === "git branch --show-current") return ok("main\n");
      if (cmd.startsWith("git ls-files")) return ok("scratch.txt\n");
      if (cmd === "git diff --name-only snapA snapB") return ok("tests/test_shell.py\n");
      if (cmd.startsWith("git diff --no-color --no-ext-diff snapA snapB --"))
        return ok("diff --git a/tests/test_shell.py b/tests/test_shell.py\ndeleted file mode 100644\n--- a/tests/test_shell.py\n+++ /dev/null\n-    assert x == 1\n");
      if (argv[0] === "/bin/sh") return ok("1 passed in 0.01s\n");
      return ok("", 1);
    });
    setReceiptEngineDepsForTests({
      run,
      turnList: (async () => ({ git: true, turns: [{ n: 1, start: { ref: "a", commit: "snapA", tree: "t", ts_ms: 1000 }, end: { ref: "b", commit: "snapB", tree: "t", ts_ms: 5000 } }] })) as never,
    });
    const r = await verifyTurn({ ...target, filesTouched: [] });
    expect(r!.filesTouched).toEqual(["tests/test_shell.py"]);
    expect(r!.tamper[0]).toMatchObject({ path: "tests/test_shell.py", reason: "test-deleted", severity: "review" });
    expect(r!.status).toBe("tests-changed");
  });

  it("asks for the end snapshot once more when it has not landed yet", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    const turns = [
      [{ n: 1, start: { ref: "a", commit: "snapA", tree: "t", ts_ms: 1000 }, end: null }],
      [{ n: 1, start: { ref: "a", commit: "snapA", tree: "t", ts_ms: 1000 }, end: { ref: "b", commit: "snapB", tree: "t", ts_ms: 5000 } }],
    ];
    const turnList = vi.fn(async () => ({ git: true, turns: turns.shift() ?? [] }));
    const run = fakeRun();
    setReceiptEngineDepsForTests({ run, turnList: turnList as never });
    const r = await verifyTurn(target);
    expect(turnList).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([, argv]) => argv.join(" ") === "git diff --name-only snapA snapB")).toBe(true);
    expect(r!.base).toBe("turn start (snapA)");
  });

  it("does nothing for a turn that changed no files", async () => {
    setReceiptEngineDepsForTests({ run: fakeRun({ changed: "" }) });
    expect(await verifyTurn({ ...target, filesTouched: [] })).toBeNull();
    expect(receiptFor("s1")).toBeNull();
    expect(askBrain).not.toHaveBeenCalled();
  });

  it("reuses a verdict for identical evidence instead of paying twice", async () => {
    askBrain.mockResolvedValue({ ok: true, text: "", value: { verdict: "partial", asked: "a", did: "d", evidence: [], gaps: [] }, costUsd: 0.01 });
    await verifyTurn(target);
    const again = await verifyTurn(target);
    expect(askBrain).toHaveBeenCalledTimes(1);
    expect(again!.costUsd).toBeNull();
  });
});

describe("scheduling", () => {
  it("folds a session's turns that end while it waits into one verification", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    const first = scheduleVerify({ ...target, sessionId: "busy" });
    const a = scheduleVerify({ ...target, filesTouched: ["a.ts"] });
    const b = scheduleVerify({ ...target, filesTouched: ["b.ts"], prompt: "second" });
    expect(a).toBe(b);
    await Promise.all([first, a]);
    expect(appended.map((d) => d.sessionId)).toEqual(["busy", "s1"]);
    expect(appended[1].asked).toBe("second");
  });

  it("runs one verification at a time, across repositories too", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    let active = 0;
    let peak = 0;
    const inner = fakeRun();
    setReceiptEngineDepsForTests({
      run: async (cwd, argv, opts) => {
        if (argv[0] === "/bin/sh") {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }
        return inner(cwd, argv, opts);
      },
    });
    await Promise.all([
      scheduleVerify({ ...target, sessionId: "a", root: "/repo" }),
      scheduleVerify({ ...target, sessionId: "b", root: "/other" }),
    ]);
    expect(peak).toBe(1);
    expect(appended.map((d) => d.sessionId)).toEqual(["a", "b"]);
  });

  it("only verifies automatically in auto mode", async () => {
    updateSettings({ receiptMode: "manual" });
    onTurnEnd({ turnId: "t", ptyId: 1, sessionId: "m", cli: "x", cwd: "/repo", root: "/repo", filesTouched: ["a.ts"], startedAt: 1, endedAt: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(appended).toHaveLength(0);
  });
});

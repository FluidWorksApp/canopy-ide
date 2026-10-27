// Runs the restore against a real git repository: the point is that the
// plumbing really leaves history alone and the files really match.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({}));

import { parseNameStatus, previewRestore, restoreVersion, type RestoreDeps } from "./lensRestore";

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const deps: RestoreDeps = {
  run: async (cwd, argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
    return {
      code: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
      spawnError: r.error ? String(r.error) : null,
    };
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lens-restore-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "app.txt"), "v1\n");
  writeFileSync(join(dir, "old.txt"), "keep me\n");
  git("add", "-A");
  git("commit", "-q", "-m", "vibe: First version");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("going back to a saved version", () => {
  it("previews, then restores as a new version on top — history untouched", async () => {
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "app.txt"), "v2\n");
    writeFileSync(join(dir, "new.txt"), "later\n");
    execFileSync("git", ["rm", "-q", "old.txt"], { cwd: dir });
    git("add", "-A");
    git("commit", "-q", "-m", "vibe: Second version");
    const second = git("rev-parse", "HEAD");

    const preview = await previewRestore(dir, first, deps);
    expect(preview.changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "app.txt", status: "revert" },
      { path: "new.txt", status: "remove" },
      { path: "old.txt", status: "restore" },
    ]);
    expect(preview.patch).toContain("-v2");
    expect(preview.patch).toContain("+v1");
    expect(preview.unsaved).toBe(0);

    const out = await restoreVersion(dir, first, "First version", deps);
    expect(out.changed).toBe(3);
    expect(out.savedFirst).toBeNull();
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(readFileSync(join(dir, "old.txt"), "utf8")).toBe("keep me\n");
    // A new commit whose parent is the old head: nothing rewritten.
    expect(git("rev-parse", "HEAD^")).toBe(second);
    expect(git("log", "-1", "--format=%s")).toBe("vibe: Back to First version");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(git("rev-parse", `${first}^{tree}`));
  });

  it("saves unsaved work first, so the restore can be undone too", async () => {
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "app.txt"), "half done\n");
    writeFileSync(join(dir, "draft.txt"), "untracked\n");
    const preview = await previewRestore(dir, first, deps);
    expect(preview.unsaved).toBe(2);
    expect(preview.changes).toContainEqual({ path: "draft.txt", status: "remove" });
    const out = await restoreVersion(dir, first, "First version", deps);
    expect(out.savedFirst).toBeTruthy();
    expect(git("log", "-1", "--format=%s", out.savedFirst!)).toBe("vibe: Before going back to First version");
    expect(git("show", `${out.savedFirst}:draft.txt`)).toBe("untracked");
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "draft.txt"))).toBe(false);
  });

  it("does nothing when the files already match", async () => {
    const out = await restoreVersion(dir, git("rev-parse", "HEAD"), "First version", deps);
    expect(out).toEqual({ commit: null, savedFirst: null, changed: 0 });
  });

  it("refuses something that isn't a commit", async () => {
    await expect(previewRestore(dir, "not a sha; rm -rf /", deps)).rejects.toThrow("isn't a saved version");
    await expect(restoreVersion(dir, "deadbeef", "x", deps)).rejects.toThrow();
  });

  it("reads name-status from the saved version's side", () => {
    expect(parseNameStatus("A\tnew.ts\nD\tgone.ts\nM\tsrc/a.ts\nR100\tx\ty\n")).toEqual([
      { path: "new.ts", status: "remove" },
      { path: "gone.ts", status: "restore" },
      { path: "src/a.ts", status: "revert" },
    ]);
  });
});

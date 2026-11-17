import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ChannelError, checkoutAt, copyPath, runOn, safeRelativePath, shOn, type Checkout } from "./channel";
import { syncCheckout } from "./sync";
import { desktopMachine, dispose, workspaceMachine, type TestMachine } from "./testMachines";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
const write = (dir: string, rel: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};
const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), "utf8");
const status = (dir: string) => git(dir, "status", "--porcelain=v1", "--untracked-files=all");

// Every test here runs real git on real folders, many processes each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mac: TestMachine;
let box: TestMachine;

beforeAll(async () => {
  mac = desktopMachine();
  box = await workspaceMachine();
});
afterAll(() => dispose(mac, box));

let serial = 0;
/** One repository, cloned on both machines under different folders and names. */
async function twoCheckouts(): Promise<{ here: Checkout; there: Checkout; origin: string }> {
  const n = serial++;
  const origin = path.join(mac.home, `origin-${n}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(mac.home, `seed-${n}`);
  execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" });
  for (const dir of [seed]) {
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.invalid");
  }
  write(seed, "README.md", "hello\n");
  write(seed, "src/main.c", "int main(void) { return 0; }\n");
  write(seed, "src/old.c", "/* to be deleted */\n");
  write(seed, ".gitignore", "build/\n.env\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "first");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const hereDir = path.join(mac.home, "code", `app-${n}`);
  const thereDir = path.join(box.home, "workspace", `project-${n}`);
  mkdirSync(path.dirname(hereDir), { recursive: true });
  mkdirSync(path.dirname(thereDir), { recursive: true });
  execFileSync("git", ["clone", "-q", origin, hereDir], { stdio: "ignore" });
  execFileSync("git", ["clone", "-q", origin, thereDir], { stdio: "ignore" });
  for (const dir of [hereDir, thereDir]) {
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.invalid");
  }
  rmSync(seed, { recursive: true, force: true });
  return { here: await checkoutAt(mac, hereDir), there: await checkoutAt(box, thereDir), origin };
}

describe("runOn", () => {
  it("returns the exit code and the output, on either kind of machine", async () => {
    for (const machine of [mac, box]) {
      const ok = await runOn(machine, { cwd: machine.home, argv: ["sh", "-c", "echo out; echo err >&2; exit 3"] });
      expect(ok).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false, spawnError: null });
    }
  });

  it("passes arguments untouched by any shell", async () => {
    const tricky = `a b"c'd $HOME;rm`;
    const result = await shOn(box, box.home, 'printf %s "$1"', [tricky]);
    expect(result.stdout).toBe(tricky);
  });

  it("reports a run that ran out of time as timed out, not failed", async () => {
    const result = await runOn(box, { cwd: box.home, argv: ["sleep", "30"], timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it("reports a program that does not exist", async () => {
    const result = await runOn(box, { cwd: box.home, argv: ["no-such-program-anywhere"] });
    expect(result.spawnError).toContain("no-such-program-anywhere");
  });

  it("refuses a view-only machine and a missing command", async () => {
    await expect(runOn({ ...box, readOnly: true }, { cwd: box.home, argv: ["true"] })).rejects.toThrow(/view-only/);
    await expect(runOn(box, { cwd: box.home, argv: [] })).rejects.toThrow(ChannelError);
  });
});

describe("safeRelativePath", () => {
  it("accepts paths inside the repository", () => {
    expect(safeRelativePath("app/build/out.apk")).toBe("app/build/out.apk");
    expect(safeRelativePath("./app//build/")).toBe("app/build");
  });

  it("refuses every way out of it", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "~/x", "C:\\x", ".git/config", ".git", "", "  "]) {
      expect(() => safeRelativePath(bad), bad).toThrow(ChannelError);
    }
  });
});

describe("copyPath", () => {
  it("copies a build artifact from the workspace to this Mac, byte for byte, executable bit included", async () => {
    const { here, there } = await twoCheckouts();
    const artifact = randomBytes(1_900_000);
    write(there.top, "build/out/app.bin", artifact);
    chmodSync(path.join(there.top, "build/out/app.bin"), 0o755);
    const seen: number[] = [];
    const result = await copyPath(there, here, "build/out/app.bin", undefined, (done) => seen.push(done));
    expect(result).toMatchObject({ kind: "file", bytes: artifact.length, path: path.join(here.top, "build/out/app.bin") });
    expect(readFileSync(result.path).equals(artifact)).toBe(true);
    expect(statSync(result.path).mode & 0o111).not.toBe(0);
    expect(seen.at(-1)).toBe(artifact.length);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("copies to a workspace, replacing the copy from last time", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "dist/bundle.js", "first build\n");
    await copyPath(here, there, "dist/bundle.js");
    expect(read(there.top, "dist/bundle.js")).toBe("first build\n");
    const second = randomBytes(600_000);
    write(here.top, "dist/bundle.js", second);
    await copyPath(here, there, "dist/bundle.js", "out/renamed.js");
    await copyPath(here, there, "dist/bundle.js");
    expect(readFileSync(path.join(there.top, "dist/bundle.js")).equals(second)).toBe(true);
    expect(readFileSync(path.join(there.top, "out/renamed.js")).equals(second)).toBe(true);
    // Nothing of the transfer is left behind on either side.
    expect(existsSync(path.join(box.home, ".canopy-uploads")) ? execFileSync("ls", [path.join(box.home, ".canopy-uploads")], { encoding: "utf8" }) : "").toBe("");
  });

  it("copies an empty file", async () => {
    const { here, there } = await twoCheckouts();
    write(there.top, "build/empty", "");
    await copyPath(there, here, "build/empty");
    expect(read(here.top, "build/empty")).toBe("");
    write(here.top, "build/empty2", "");
    await copyPath(here, there, "build/empty2");
    expect(read(there.top, "build/empty2")).toBe("");
  });

  it("copies a folder as one piece and unpacks it in place", async () => {
    const { here, there } = await twoCheckouts();
    write(there.top, "build/site/index.html", "<h1>hi</h1>\n");
    write(there.top, "build/site/assets/app.js", "console.log(1)\n");
    write(here.top, "build/site/kept.txt", "already here\n");
    const result = await copyPath(there, here, "build/site");
    expect(result.kind).toBe("folder");
    expect(read(here.top, "build/site/index.html")).toBe("<h1>hi</h1>\n");
    expect(read(here.top, "build/site/assets/app.js")).toBe("console.log(1)\n");
    expect(read(here.top, "build/site/kept.txt")).toBe("already here\n");
    // The archive is gone from both git directories.
    for (const c of [here, there]) expect(execFileSync("sh", ["-c", `ls "${c.common}/canopy-sync" 2>/dev/null | grep tgz || true`], { encoding: "utf8" })).toBe("");
  });

  it("says so when the file is not there, and never leaves the repository", async () => {
    const { here, there } = await twoCheckouts();
    await expect(copyPath(there, here, "build/nope.apk")).rejects.toThrow(/does not exist/);
    await expect(copyPath(there, here, "../outside")).rejects.toThrow(/leaves the repository/);
    await expect(copyPath(there, here, "README.md", "/tmp/x")).rejects.toThrow(/relative/);
  });
});

describe("syncCheckout", () => {
  it("carries commits, edits, new files and deletions; leaves ignored files where they are", async () => {
    const { here, there } = await twoCheckouts();
    git(here.top, "checkout", "-q", "-b", "feature/login");
    write(here.top, "src/main.c", "int main(void) { return 1; }\n");
    git(here.top, "commit", "-q", "-am", "unpushed commit");
    write(here.top, "src/main.c", "int main(void) { return 2; } /* uncommitted */\n");
    write(here.top, "src/new file.c", "/* untracked, with a space */\n");
    rmSync(path.join(here.top, "src/old.c"));
    write(here.top, "build/cache.o", "never travels\n");
    write(here.top, ".env", "SECRET=1\n");
    write(here.top, "staged.txt", "staged\n");
    git(here.top, "add", "staged.txt");
    write(there.top, "build/their-output.o", "stays\n");
    const before = status(here.top);

    const result = await syncCheckout(here, there);

    expect(result.alreadyInSync).toBe(false);
    expect(result.branch).toBe("feature/login");
    expect(result.bytes).toBeGreaterThan(0);
    expect(git(there.top, "rev-parse", "HEAD")).toBe(git(here.top, "rev-parse", "HEAD"));
    expect(git(there.top, "symbolic-ref", "--short", "HEAD")).toBe("feature/login");
    expect(read(there.top, "src/main.c")).toContain("uncommitted");
    expect(read(there.top, "src/new file.c")).toContain("untracked");
    expect(existsSync(path.join(there.top, "src/old.c"))).toBe(false);
    expect(read(there.top, "staged.txt")).toBe("staged\n");
    // Ignored: neither sent nor disturbed.
    expect(existsSync(path.join(there.top, "build/cache.o"))).toBe(false);
    expect(existsSync(path.join(there.top, ".env"))).toBe(false);
    expect(read(there.top, "build/their-output.o")).toBe("stays\n");
    // The source is exactly as it was, staging included.
    expect(status(here.top)).toBe(before);
    // The destination shows the same work as uncommitted (staging is not carried).
    expect(status(there.top).split("\n").map((l) => l.slice(3)).sort()).toEqual(before.split("\n").map((l) => l.slice(3)).sort());
  });

  it("syncs again and again: only the new difference moves", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "a.txt", "one\n");
    const first = await syncCheckout(here, there);
    write(here.top, "a.txt", "two\n");
    write(here.top, "b.txt", "new\n");
    const second = await syncCheckout(here, there);
    expect(read(there.top, "a.txt")).toBe("two\n");
    expect(read(there.top, "b.txt")).toBe("new\n");
    expect(second.changedFiles).toBe(2);
    expect(second.bytes).toBeLessThan(first.bytes + 2000);
    // A file the source dropped after it was synced is dropped there too.
    rmSync(path.join(here.top, "b.txt"));
    await syncCheckout(here, there);
    expect(existsSync(path.join(there.top, "b.txt"))).toBe(false);
  });

  it("does nothing when both already match", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "a.txt", "one\n");
    await syncCheckout(here, there);
    const again = await syncCheckout(here, there);
    expect(again).toMatchObject({ alreadyInSync: true, bytes: 0, changedFiles: 0 });
  });

  it("goes back the other way once the other machine has made changes", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "a.txt", "from the mac\n");
    await syncCheckout(here, there);
    // The build machine's agent fixes something and commits it.
    write(there.top, "a.txt", "fixed on the build machine\n");
    git(there.top, "add", "a.txt");
    git(there.top, "commit", "-q", "-m", "fix there");
    write(there.top, "generated.txt", "made there\n");
    await syncCheckout(there, here);
    expect(read(here.top, "a.txt")).toBe("fixed on the build machine\n");
    expect(read(here.top, "generated.txt")).toBe("made there\n");
    expect(git(here.top, "rev-parse", "HEAD")).toBe(git(there.top, "rev-parse", "HEAD"));
    // And forward again.
    write(here.top, "a.txt", "third\n");
    await syncCheckout(here, there);
    expect(read(there.top, "a.txt")).toBe("third\n");
  });

  it("refuses to replace changes the destination made itself, and names them", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "a.txt", "one\n");
    await syncCheckout(here, there);
    write(there.top, "their-work.txt", "not synced back\n");
    write(here.top, "a.txt", "two\n");
    const error = await syncCheckout(here, there).catch((e) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.message).toMatch(/changes of its own/);
    expect(error.detail).toContain("their-work.txt");
    // Nothing was touched.
    expect(read(there.top, "their-work.txt")).toBe("not synced back\n");
    expect(read(there.top, "a.txt")).toBe("one\n");
  });

  it("replaces them when told to, keeping what was there as a backup commit", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "a.txt", "one\n");
    await syncCheckout(here, there);
    write(there.top, "their-work.txt", "not synced back\n");
    write(here.top, "a.txt", "two\n");
    await syncCheckout(here, there, { overwrite: true });
    expect(read(there.top, "a.txt")).toBe("two\n");
    expect(existsSync(path.join(there.top, "their-work.txt"))).toBe(false);
    const backup = git(there.top, "for-each-ref", "--format=%(refname)", "refs/canopy/sync").split("\n").find((r) => r.endsWith("/backup"));
    expect(backup).toBeTruthy();
    expect(git(there.top, "show", `${backup}:their-work.txt`)).toBe("not synced back");
  });

  it("refuses when the destination has commits the source lacks", async () => {
    const { here, there } = await twoCheckouts();
    write(there.top, "c.txt", "committed there\n");
    git(there.top, "add", "-A");
    git(there.top, "commit", "-q", "-m", "only on the build machine");
    write(here.top, "a.txt", "one\n");
    const error = await syncCheckout(here, there).catch((e) => e);
    expect(error.message).toMatch(/commits that .* does not have/);
    expect(error.detail).toContain("only on the build machine");
    expect(read(there.top, "c.txt")).toBe("committed there\n");
  });

  it("follows the source after it rewrites its own history", async () => {
    const { here, there } = await twoCheckouts();
    write(here.top, "a.txt", "one\n");
    git(here.top, "add", "-A");
    git(here.top, "commit", "-q", "-m", "wip");
    await syncCheckout(here, there);
    git(here.top, "commit", "-q", "--amend", "-m", "better message");
    await syncCheckout(here, there);
    expect(git(there.top, "log", "-1", "--format=%s")).toBe("better message");
  });

  it("puts the destination on a detached HEAD when the source is on one", async () => {
    const { here, there } = await twoCheckouts();
    git(here.top, "checkout", "-q", "--detach");
    write(here.top, "a.txt", "detached work\n");
    await syncCheckout(here, there);
    expect(() => git(there.top, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(read(there.top, "a.txt")).toBe("detached work\n");
  });

  it("syncs from a worktree beside the repository", async () => {
    const { here, there } = await twoCheckouts();
    const wt = `${here.top}-wt-fix`;
    git(here.top, "worktree", "add", "-q", "-b", "fix", wt);
    write(wt, "fix.txt", "in the worktree\n");
    const worktree = await checkoutAt(mac, wt);
    expect(worktree.common).toBe(path.join(here.top, ".git"));
    await syncCheckout(worktree, there);
    expect(git(there.top, "symbolic-ref", "--short", "HEAD")).toBe("fix");
    expect(read(there.top, "fix.txt")).toBe("in the worktree\n");
  });

  it("refuses a view-only destination and a checkout synced onto itself", async () => {
    const { here, there } = await twoCheckouts();
    await expect(syncCheckout(here, { ...there, machine: { ...box, readOnly: true } })).rejects.toThrow(/view-only/);
    await expect(syncCheckout(here, here)).rejects.toThrow(/same checkout/);
  });

  it("only ever asks a workspace for commands it already serves", async () => {
    const { here, there } = await twoCheckouts();
    box.calls.length = 0;
    write(here.top, "a.txt", "one\n");
    await syncCheckout(here, there);
    await copyPath(here, there, "a.txt", "copy.txt");
    await copyPath(there, here, "copy.txt");
    expect([...new Set(box.calls)].sort()).toEqual(["fs_read_range", "fs_upload_begin", "fs_upload_chunk", "fs_upload_dir", "fs_upload_finish", "receipt_run_check"]);
  });
});

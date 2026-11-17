import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { forgetCheckouts, runMachineOp, type ConsentRequest, type KnownMachine, type MachineDirectory, type MachineOpContext } from "./ops";
import { parseRecipe, RECIPE_PATH, workflowMachines } from "./recipe";
import { desktopMachine, dispose, workspaceMachine, type TestMachine } from "./testMachines";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
const write = (dir: string, rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};
const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), "utf8");

// Every test here runs real git on real folders, many processes each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mac: TestMachine;
let box: TestMachine;
let hereDir: string;
let thereDir: string;
let serial = 0;
let asked: ConsentRequest[] = [];
let answer = true;

const known = (): KnownMachine[] => [
  { id: "local", name: "This Mac", kind: "this-mac", reachable: true },
  { id: box.id, name: box.name, kind: "own", reachable: true },
  { id: "w-asleep", name: "Asleep", kind: "cloud", reachable: false },
];
const directory: MachineDirectory = {
  list: async () => known(),
  open: async (id) => {
    if (id === "local") return mac;
    if (id === box.id) return box;
    throw new Error("not reachable");
  },
};
/** A request from an agent on `origin`, in `cwd`. */
const from = (origin: TestMachine, cwd: string): MachineOpContext => ({
  originId: origin.id,
  cwd,
  directory,
  consent: async (request) => {
    asked.push(request);
    return answer;
  },
});

const RECIPE = {
  machines: { build: "Build Box", device: "this-mac" },
  carry: [".env.local"],
  workflows: {
    build: {
      description: "Build over there, install here",
      steps: [
        { sync: { from: "here", to: "build" } },
        { run: { on: "build", command: "mkdir -p build && cat src/main.c .env.local > build/app.bin && echo built" } },
        { copy: { from: "build", to: "device", path: "build/app.bin" } },
        { run: { on: "device", command: "cp build/app.bin build/installed.bin && echo installed" } },
      ],
    },
    broken: [{ run: { on: "build", command: "echo compiling; echo 'error: missing semicolon' >&2; exit 2" } }, { run: { on: "device", command: "echo never" } }],
  },
};

beforeAll(async () => {
  mac = desktopMachine();
  box = await workspaceMachine();
});
afterAll(() => dispose(mac, box));

beforeEach(() => {
  const n = serial++;
  asked = [];
  answer = true;
  forgetCheckouts();
  mac.calls.length = 0;
  box.calls.length = 0;
  const origin = path.join(mac.home, `origin-${n}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  // The same repository under different folders and different project names:
  // on the Mac directly a project, on the workspace one level under its root.
  hereDir = path.join(mac.home, "code", `ide-${n}`);
  thereDir = path.join(box.home, `root-${n}`, "app");
  mkdirSync(path.dirname(hereDir), { recursive: true });
  mkdirSync(path.dirname(thereDir), { recursive: true });
  execFileSync("git", ["clone", "-q", origin, hereDir], { stdio: "ignore" });
  for (const dir of [hereDir]) {
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.invalid");
  }
  write(hereDir, "src/main.c", "int main(void) { return 0; }\n");
  write(hereDir, ".gitignore", "build/\n.env.local\n");
  write(hereDir, RECIPE_PATH, JSON.stringify(RECIPE, null, 2));
  git(hereDir, "add", "-A");
  git(hereDir, "commit", "-q", "-m", "first");
  git(hereDir, "push", "-q", "origin", "HEAD:main");
  // The origin is spelled differently on the other machine.
  execFileSync("git", ["clone", "-q", origin, thereDir], { stdio: "ignore" });
  git(thereDir, "config", "user.name", "Test");
  git(thereDir, "config", "user.email", "test@example.invalid");
  git(hereDir, "remote", "set-url", "origin", `git@github.com:acme/app-${n}.git`);
  git(thereDir, "remote", "set-url", "origin", `https://github.com/acme/app-${n}`);
  mac.projects.length = 0;
  mac.projects.push(hereDir);
  box.projects.length = 0;
  box.projects.push(path.dirname(thereDir));
});

describe("parseRecipe", () => {
  it("reads machines, carried files and workflows", () => {
    const recipe = parseRecipe(JSON.stringify(RECIPE));
    expect(recipe.machines).toEqual({ build: "Build Box", device: "this-mac" });
    expect(recipe.carry).toEqual([".env.local"]);
    expect(recipe.workflows.build.steps.map((s) => s.kind)).toEqual(["sync", "run", "copy", "run"]);
    expect(recipe.workflows.broken.steps).toHaveLength(2);
    expect(workflowMachines(recipe.workflows.build)).toEqual(["here", "build", "device"]);
  });

  it("is empty for no file", () => {
    expect(parseRecipe("").workflows).toEqual({});
  });

  it("names exactly what is wrong", () => {
    const bad = (value: unknown) => {
      try {
        parseRecipe(typeof value === "string" ? value : JSON.stringify(value));
      } catch (error) {
        return String((error as Error).message);
      }
      return "accepted";
    };
    expect(bad("{nope")).toMatch(/not valid JSON/);
    expect(bad([])).toMatch(/must be a JSON object/);
    expect(bad({ workflows: { build: { steps: [] } } })).toMatch(/has no steps/);
    expect(bad({ workflows: { build: [{ deploy: {} }] } })).toMatch(/step 1 must have exactly one of/);
    expect(bad({ workflows: { build: [{ run: { on: "x" } }] } })).toMatch(/step 1\.run\.command/);
    expect(bad({ workflows: { build: [{ copy: { from: "a", to: "b", path: "../../etc/passwd" } }] } })).toMatch(/leaves the repository/);
    expect(bad({ workflows: { "bad name!": [{ run: { on: "x", command: "y" } }] } })).toMatch(/not a usable workflow name/);
    expect(bad({ checkouts: { build: "relative/path" } })).toMatch(/absolute path/);
    expect(bad({ carry: ["/etc/passwd"] })).toMatch(/relative to the repository/);
  });
});

describe("machine ops", () => {
  it("lists the machines, where this repository is on each, and the workflows", async () => {
    const result = (await runMachineOp("list", {}, from(mac, hereDir))) as {
      repository: string;
      machines: { name: string; here: boolean; checkout: string | null; note?: string }[];
      workflows: { name: string; steps: string[] }[];
    };
    expect(result.repository).toMatch(/^github\.com\/acme\/app-/);
    expect(result.machines).toEqual([
      expect.objectContaining({ name: "This Mac", here: true, checkout: hereDir }),
      expect.objectContaining({ name: "Build Box", here: false, checkout: thereDir }),
      expect.objectContaining({ name: "Asleep", checkout: null, note: "not running" }),
    ]);
    expect(result.workflows.map((w) => w.name)).toEqual(["build", "broken"]);
    expect(result.workflows[0].steps[1]).toMatch(/^run on build: /);
    // Looking never asks for permission.
    expect(asked).toEqual([]);
  });

  it("runs the whole build workflow: sync there, build there, bring the artifact back, install here", async () => {
    write(hereDir, "src/main.c", "int main(void) { return 42; } /* not committed */\n");
    write(hereDir, ".env.local", "API_KEY=local\n");
    const progress: string[] = [];
    const result = (await runMachineOp("workflow", { name: "build" }, { ...from(mac, hereDir), onProgress: (line) => progress.push(line) })) as {
      ok: boolean;
      steps: { ok: boolean; step: string; result?: string; output?: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(result.steps[1].output).toContain("built");
    expect(result.steps[3].output).toContain("installed");
    // Built on the other machine from this machine's uncommitted work and its ignored .env…
    expect(read(thereDir, "build/app.bin")).toBe("int main(void) { return 42; } /* not committed */\nAPI_KEY=local\n");
    // …and the artifact came back and was "installed" here.
    expect(read(hereDir, "build/installed.bin")).toBe(read(thereDir, "build/app.bin"));
    expect(progress).toHaveLength(4);
    expect(progress[0]).toBe("build 1/4: sync here → build");
    // Asked once about the one other machine, however many steps touch it.
    expect(asked).toEqual([{ from: { id: "local", name: "This Mac" }, to: { id: box.id, name: "Build Box" }, repository: expect.stringMatching(/acme\/app-/) }]);
  });

  it("works the same when the agent is the one on the build machine", async () => {
    // Remote IDE: the agent edits and builds on the workspace, the phone is on the Mac.
    write(thereDir, "src/main.c", "int main(void) { return 7; }\n");
    const built = (await runMachineOp("run", { command: "mkdir -p build && cp src/main.c build/app.bin" }, from(box, path.join(thereDir, "src")))) as { ok: boolean; cwd: string };
    expect(built).toMatchObject({ ok: true, cwd: thereDir });
    const copied = (await runMachineOp("copy", { from: "here", to: "this-mac", path: "build/app.bin" }, from(box, thereDir))) as { path: string; to: string };
    expect(copied).toMatchObject({ to: "This Mac", path: path.join(hereDir, "build/app.bin") });
    const installed = (await runMachineOp("run", { machine: "this-mac", command: "cat build/app.bin", sync: false }, from(box, thereDir))) as { stdout: string; machine: string };
    expect(installed).toMatchObject({ machine: "This Mac", stdout: "int main(void) { return 7; }\n" });
    expect(asked.map((a) => `${a.from.name}>${a.to.name}`)).toEqual(["Build Box>This Mac", "Build Box>This Mac"]);
  });

  it("syncs before running on another machine, unless told not to", async () => {
    write(hereDir, "notes.txt", "fresh\n");
    const run = (await runMachineOp("run", { machine: "Build Box", command: "cat notes.txt" }, from(mac, hereDir))) as { stdout: string; synced?: string; ok: boolean };
    expect(run.ok).toBe(true);
    expect(run.stdout).toBe("fresh\n");
    expect(run.synced).toMatch(/Build Box now matches This Mac/);
    write(hereDir, "notes.txt", "newer\n");
    const stale = (await runMachineOp("run", { machine: "build box", command: "cat notes.txt", sync: false }, from(mac, hereDir))) as { stdout: string; synced?: string };
    expect(stale.stdout).toBe("fresh\n");
    expect(stale.synced).toBeUndefined();
  });

  it("reports a failing command as a result, with its output", async () => {
    const run = (await runMachineOp("run", { machine: "here", command: "echo out; echo bad >&2; exit 3", dir: "src" }, from(mac, hereDir))) as Record<string, unknown>;
    expect(run).toMatchObject({ ok: false, code: 3, stdout: "out\n", stderr: "bad\n", cwd: path.join(hereDir, "src"), problem: "it exited with code 3" });
  });

  it("stops a workflow at the step that failed and shows why", async () => {
    const result = (await runMachineOp("workflow", { name: "broken" }, from(mac, hereDir))) as { ok: boolean; failedStep: number; steps: Record<string, unknown>[] };
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ ok: false, stderr: "error: missing semicolon\n", stdout: "compiling\n" });
  });

  it("lets whoever runs a workflow name different machines for its roles", async () => {
    // Both roles on this Mac: nothing leaves it, nobody is asked.
    const result = (await runMachineOp("workflow", { name: "build", machines: { build: "this-mac" } }, from(mac, hereDir))) as {
      ok: boolean;
      steps: { problem?: string }[];
    };
    expect(result.ok).toBe(false);
    expect(result.steps[0].problem).toMatch(/same machine/);
    expect(asked).toEqual([]);
  });

  it("does nothing on another machine when the person says no", async () => {
    answer = false;
    write(hereDir, "notes.txt", "fresh\n");
    await expect(runMachineOp("sync", { to: "Build Box" }, from(mac, hereDir))).rejects.toThrow(/did not let agents on This Mac work on Build Box/);
    await expect(runMachineOp("workflow", { name: "build" }, from(mac, hereDir))).rejects.toThrow(/did not let/);
    expect(existsSync(path.join(thereDir, "notes.txt"))).toBe(false);
    expect(box.calls.filter((c) => c.startsWith("fs_upload"))).toEqual([]);
  });

  it("explains a machine it does not know, one that is asleep, and a repository that is not there", async () => {
    await expect(runMachineOp("run", { machine: "Nope", command: "true" }, from(mac, hereDir))).rejects.toThrow(/No machine called "Nope". There are: This Mac, Build Box, Asleep \(roles: build, device\)/);
    await expect(runMachineOp("run", { machine: "Asleep", command: "true" }, from(mac, hereDir))).rejects.toThrow(/not running/);
    box.projects.length = 0;
    forgetCheckouts();
    await expect(runMachineOp("sync", { to: "Build Box" }, from(mac, hereDir))).rejects.toThrow(/is not set up on Build Box/);
  });

  it("refuses a folder that is no repository, and a repository with no origin", async () => {
    await expect(runMachineOp("list", {}, from(mac, mac.home))).rejects.toThrow(/not inside a git repository/);
    git(hereDir, "remote", "remove", "origin");
    await expect(runMachineOp("list", {}, from(mac, hereDir))).rejects.toThrow(/has no origin remote/);
  });

  it("carries the files in the way when a sync is refused", async () => {
    await runMachineOp("sync", { to: "Build Box" }, from(mac, hereDir));
    write(thereDir, "their.txt", "made there\n");
    write(hereDir, "mine.txt", "made here\n");
    const error = (await runMachineOp("sync", { to: "Build Box" }, from(mac, hereDir)).catch((e) => e)) as Error;
    expect(error.message).toMatch(/changes of its own/);
    expect(error.message).toContain("their.txt");
    const forced = (await runMachineOp("sync", { to: "Build Box", overwrite: true }, from(mac, hereDir))) as { summary: string };
    expect(forced.summary).toMatch(/now matches/);
    expect(existsSync(path.join(thereDir, "their.txt"))).toBe(false);
  });

  it("never copies outside the repository", async () => {
    await expect(runMachineOp("copy", { from: "here", to: "Build Box", path: "../secret" }, from(mac, hereDir))).rejects.toThrow(/leaves the repository/);
    await expect(runMachineOp("copy", { from: "here", to: "Build Box", path: "/etc/passwd" }, from(mac, hereDir))).rejects.toThrow(/relative/);
    await expect(runMachineOp("run", { machine: "here", command: "true", dir: "../.." }, from(mac, hereDir))).rejects.toThrow(/leaves the repository/);
  });

  it("uses the checkout the recipe pins for a machine", async () => {
    const other = path.join(box.home, `elsewhere-${serial}`);
    execFileSync("git", ["clone", "-q", thereDir, other], { stdio: "ignore" });
    git(other, "remote", "set-url", "origin", git(thereDir, "remote", "get-url", "origin"));
    write(hereDir, RECIPE_PATH, JSON.stringify({ ...RECIPE, checkouts: { build: other } }));
    const run = (await runMachineOp("run", { machine: "build", command: "pwd", sync: false }, from(mac, hereDir))) as { cwd: string };
    expect(run.cwd).toBe(other);
    write(hereDir, RECIPE_PATH, JSON.stringify({ ...RECIPE, checkouts: { build: box.home } }));
    await expect(runMachineOp("run", { machine: "build", command: "pwd", sync: false }, from(mac, hereDir))).rejects.toThrow(/not a checkout of it/);
  });
});

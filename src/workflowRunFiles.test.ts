import { describe, expect, it } from "vitest";
import {
  excludeRunsFromGit,
  prepareWorkflowRunDir,
  readVerdictFile,
  RUNS_EXCLUDE_LINE,
  type WorkflowRunFilesIo,
} from "./workflowRunFiles";

function memoryIo(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial));
  const io: WorkflowRunFilesIo = {
    exists: async (path) => disk.has(path),
    create: async (path) => {
      if (disk.has(path)) throw new Error(`${path} already exists`);
      disk.set(path, "");
    },
    write: async (path, content) => { disk.set(path, content); },
    read: async (path) => {
      const value = disk.get(path);
      if (value === undefined) throw new Error("No such file");
      return value;
    },
  };
  return { disk, io };
}

describe("prepareWorkflowRunDir", () => {
  it("creates the run folder and keeps it out of git", async () => {
    const { disk, io } = memoryIo({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.git/info/exclude": "# git ls-files --others --exclude-from=.git/info/exclude\n.canopy/pr-*\n",
    });
    const dir = await prepareWorkflowRunDir("/repo/", "run-1", io);
    expect(dir).toBe("/repo/.canopy/workflow-runs/run-1");
    expect(disk.get(`${dir}/README.md`)).toContain("run-1");
    expect(disk.get("/repo/.git/info/exclude")).toBe(
      `# git ls-files --others --exclude-from=.git/info/exclude\n.canopy/pr-*\n${RUNS_EXCLUDE_LINE}\n`,
    );
  });

  it("is idempotent across steps of the same run", async () => {
    const { disk, io } = memoryIo({ "/repo/.git/HEAD": "x", "/repo/.git/info/exclude": "a" });
    await prepareWorkflowRunDir("/repo", "run-1", io);
    await prepareWorkflowRunDir("/repo", "run-1", io);
    expect(disk.get("/repo/.git/info/exclude")).toBe(`a\n${RUNS_EXCLUDE_LINE}\n`);
  });
});

describe("excludeRunsFromGit", () => {
  it("creates a missing exclude file in a real git directory", async () => {
    const { disk, io } = memoryIo({ "/repo/.git/HEAD": "x" });
    expect(await excludeRunsFromGit("/repo", io)).toBe(true);
    expect(disk.get("/repo/.git/info/exclude")).toBe(`${RUNS_EXCLUDE_LINE}\n`);
  });

  it("leaves a checkout without a .git directory alone", async () => {
    const { disk, io } = memoryIo();
    expect(await excludeRunsFromGit("/repo", io)).toBe(false);
    expect(disk.size).toBe(0);
  });

  it("recognises an unanchored spelling the user already added", async () => {
    const { io } = memoryIo({ "/repo/.git/HEAD": "x", "/repo/.git/info/exclude": ".canopy/workflow-runs/\n" });
    expect(await excludeRunsFromGit("/repo", io)).toBe(false);
  });
});

it("reads a missing verdict file as no verdict", async () => {
  const { io } = memoryIo({ "/run/verdicts/a.r1.json": '{"verdict":"clean"}' });
  expect(await readVerdictFile("/run/verdicts/a.r1.json", io)).toBe('{"verdict":"clean"}');
  expect(await readVerdictFile("/run/verdicts/b.r1.json", io)).toBeNull();
});

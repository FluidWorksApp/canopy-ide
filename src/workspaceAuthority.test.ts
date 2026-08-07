import { describe, expect, it } from "vitest";
import {
  grantFor,
  insideWorkspace,
  judgeCommand,
  type Workspace,
} from "./workspaceAuthority";

const workspace: Workspace = {
  root: "/repo/apps/web",
  siblings: ["/repo/services/api"],
};

describe("workspace grants", () => {
  it("gives a survey no way to change what it is surveying", () => {
    const grant = grantFor("survey", workspace);
    expect(grant.authority).toBe("read-only");
    expect(grant.disallowedTools).toContain("Bash");
    expect(grant.disallowedTools).toContain("Write");
    expect(grant.writableRoots).toEqual([]);
    expect(grant.network).toBe(false);
  });

  it("gives building a shell, because making it run is the job", () => {
    // The defect this exists to prevent: the Build executor could add a
    // dependency to package.json and had no way to install it, so a turn
    // could write code that could never run, and the person was shown
    // "node_modules missing, did you mean to install?"
    for (const task of ["build", "repair", "bootstrap"] as const) {
      const grant = grantFor(task, workspace);
      expect(grant.allowedTools).toContain("Bash");
      expect(grant.authority).toBe("workspace-write");
    }
  });

  it("turns the sandbox's network on, or the shell cannot install anything", () => {
    // codex's workspace-write blocks network by default. Every setup fix is a
    // network operation, so without this the agent can only reproduce the
    // failure it was sent to repair.
    expect(grantFor("repair", workspace).network).toBe(true);
  });

  it("keeps the same boundary whatever the task", () => {
    expect(grantFor("build", workspace).writableRoots).toEqual([
      "/repo/apps/web",
      "/repo/services/api",
    ]);
  });

  it("never hands over the tools no task here needs", () => {
    for (const task of ["survey", "build", "repair", "bootstrap"] as const) {
      expect(grantFor(task, workspace).disallowedTools).toContain("KillShell");
      expect(grantFor(task, workspace).disallowedTools).toContain("NotebookEdit");
    }
  });
});

describe("judging a command", () => {
  it("lets the work happen without asking", () => {
    for (const command of [
      "npm install",
      "pnpm install --frozen-lockfile",
      "npm create vite@latest . -- --template react-ts",
      "bash -lc 'pnpm install && pnpm run build'",
      "cargo build",
      "python -m venv .venv && .venv/bin/pip install -r requirements.txt",
      "npx prisma generate",
      "git add -A && git commit -m 'wip'",
    ]) {
      expect(judgeCommand(command)).toEqual({ kind: "routine" });
    }
  });

  it("stops before deleting anything for good", () => {
    const verdict = judgeCommand("rm -rf src/legacy");
    expect(verdict.kind).toBe("confirm");
    if (verdict.kind === "confirm") expect(verdict.because).toContain("can't undo");
  });

  it("sees a destructive step hidden inside a shell chain", () => {
    // argv[0] here is `bash`. Judging only the program would wave this through.
    expect(judgeCommand("bash -lc \"npm ci && rm -rf ../../other\"").kind).toBe("confirm");
  });

  it("stops before throwing away unsaved work or shared history", () => {
    expect(judgeCommand("git reset --hard HEAD~3").kind).toBe("confirm");
    expect(judgeCommand("git clean -fd").kind).toBe("confirm");
    expect(judgeCommand("git push --force origin main").kind).toBe("confirm");
  });

  it("stops before data that is not coming back", () => {
    expect(judgeCommand("psql -c 'DROP TABLE donations'").kind).toBe("confirm");
    expect(judgeCommand("npx prisma migrate reset").kind).toBe("confirm");
  });

  it("stops before changing the whole computer", () => {
    expect(judgeCommand("sudo apt-get install pkg-config").kind).toBe("confirm");
    expect(judgeCommand("brew install postgresql").kind).toBe("confirm");
    expect(judgeCommand("npm install -g pnpm").kind).toBe("confirm");
  });

  it("stops before touching secrets", () => {
    expect(judgeCommand("cp .env.production .env").kind).toBe("confirm");
  });

  it("explains the cost rather than quoting the command", () => {
    // A non-engineer cannot adjudicate `git reset --hard`. They can decide
    // whether they mind losing unsaved work.
    const verdict = judgeCommand("git reset --hard");
    if (verdict.kind !== "confirm") throw new Error("expected a confirmation");
    expect(verdict.because).not.toContain("git");
    expect(verdict.because).not.toContain("--hard");
  });
});

describe("workspace boundary", () => {
  it("accepts the component and its siblings, and nothing above them", () => {
    expect(insideWorkspace("/repo/apps/web/src/app.tsx", workspace)).toBe(true);
    expect(insideWorkspace("/repo/services/api/main.go", workspace)).toBe(true);
    expect(insideWorkspace("/repo/apps/web", workspace)).toBe(true);
    expect(insideWorkspace("/repo/apps/other/x", workspace)).toBe(false);
    expect(insideWorkspace("/repo", workspace)).toBe(false);
    expect(insideWorkspace("/Users/someone/.ssh/id_rsa", workspace)).toBe(false);
  });

  it("does not treat a sibling-prefixed name as inside", () => {
    expect(insideWorkspace("/repo/apps/web-secrets/keys", workspace)).toBe(false);
  });
});

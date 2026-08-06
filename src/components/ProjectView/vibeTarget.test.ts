import { describe, expect, it } from "vitest";
import type { Project } from "../../projects";
import { matchesVibeRun, resolveVibeTarget } from "./helpers";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "App",
  components: [
    {
      id: "cmp-web",
      label: "Web",
      path: "/repo/web",
      commands: [
        { id: "run-dev", name: "Dev", command: "npm run dev" },
        { id: "run-blank", name: "Blank", command: "   " },
      ],
    },
  ],
  ...over,
});

describe("resolveVibeTarget", () => {
  it("requires explicit IDs even when there is only one possible target", () => {
    expect(resolveVibeTarget(project())).toEqual({ kind: "needs-setup" });
    expect(
      resolveVibeTarget(project({ vibe: { version: 1, enabled: true } })),
    ).toEqual({ kind: "needs-setup" });
  });

  it("resolves the exact configured component and run command", () => {
    const input = project({
      vibe: {
        version: 1,
        enabled: true,
        componentId: "cmp-web",
        runCommandId: "run-dev",
      },
    });

    expect(resolveVibeTarget(input)).toEqual({
      kind: "ready",
      component: input.components[0],
      runCommand: input.components[0].commands?.[0],
    });
  });

  it("stays ready across label, path, name, and command renames", () => {
    const renamed = project({
      components: [
        {
          id: "cmp-web",
          label: "Frontend",
          path: "/repo/frontend",
          commands: [{ id: "run-dev", name: "Preview", command: "pnpm dev" }],
        },
      ],
      vibe: {
        version: 1,
        enabled: true,
        componentId: "cmp-web",
        runCommandId: "run-dev",
      },
    });

    expect(resolveVibeTarget(renamed).kind).toBe("ready");
  });

  it.each([
    ["stale component", "missing", "run-dev"],
    ["stale command", "cmp-web", "missing"],
    ["blank command", "cmp-web", "run-blank"],
  ])("returns needs setup for a %s", (_label, componentId, runCommandId) => {
    expect(
      resolveVibeTarget(
        project({
          vibe: { version: 1, enabled: true, componentId, runCommandId },
        }),
      ),
    ).toEqual({ kind: "needs-setup" });
  });

  it("does not interpret an unknown future config version", () => {
    const input = project({
      vibe: {
        version: 2,
        enabled: true,
        componentId: "cmp-web",
        runCommandId: "run-dev",
      } as unknown as Project["vibe"],
    });

    expect(resolveVibeTarget(input)).toEqual({ kind: "needs-setup" });
  });
});

describe("matchesVibeRun", () => {
  const component = { id: "cmp-web", path: "/repo/web" };
  const run = { id: "run-dev", name: "Dev", command: "npm run dev" };

  it("requires stable identity and the active checkout path", () => {
    expect(
      matchesVibeRun(
        {
          cwd: "/repo/web",
          command: "different",
          componentId: "cmp-web",
          runCommandId: "run-dev",
        },
        component,
        run,
      ),
    ).toBe(true);
    expect(
      matchesVibeRun(
        {
          cwd: "/repo-wt/web",
          command: "npm run dev",
          componentId: "cmp-web",
          runCommandId: "run-dev",
        },
        component,
        run,
      ),
    ).toBe(false);
  });

  it("keeps cwd plus command fallback for legacy run tabs", () => {
    expect(
      matchesVibeRun(
        { cwd: "/repo/web", command: "npm run dev" },
        component,
        run,
      ),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { Component } from "./projects";
import {
  inferVibeCheck,
  type VibeCheckPackageFacts,
  type VibeCheckScript,
} from "./vibeCheckInference";

const component = (
  id: string,
  commands: Component["commands"] = [],
): Component => ({ id, label: id.toUpperCase(), path: `/repo/${id}`, commands });
const command = (id: string, name: string, value: string) => ({
  id,
  name,
  command: value,
});
const fact = (
  scripts: Partial<Record<VibeCheckScript, string>>,
  runner: "npm" | "pnpm" = "npm",
): VibeCheckPackageFacts[string] => ({ status: "loaded", scripts, runner });

describe("inferVibeCheck", () => {
  it("prefers a configured check-ish command over any package script", () => {
    expect(
      inferVibeCheck(
        [
          component("web", [
            command("dev", "Dev", "npm run dev"),
            command("tc", "Typecheck", "tsc --noEmit"),
          ]),
        ],
        { componentId: "web", runCommandId: "dev" },
        { web: fact({ build: "vite build" }) },
      ),
    ).toEqual({
      kind: "check",
      selection: { componentId: "web", runCommandId: "tc" },
      command: "tsc --noEmit",
      source: "existing-command",
    });
  });

  it("keeps ProjectView's array-order pick and names the runners-up", () => {
    const result = inferVibeCheck(
      [
        component("web", [
          command("b", "Build", "npm run build"),
          command("t", "Test", "npm test"),
        ]),
      ],
      { componentId: "web", runCommandId: "dev" },
    );
    expect(result).toMatchObject({
      kind: "check",
      selection: { runCommandId: "b" },
      source: "existing-command",
    });
    expect(result.kind === "check" && result.caveat).toContain("Test");
  });

  it("never reuses the command already running the app", () => {
    // The run command is itself named Build; today's derivation excludes it by
    // name, and so does this, which drops the component through to synthesis.
    expect(
      inferVibeCheck(
        [component("web", [command("b", "Build", "npm run build")])],
        { componentId: "web", runCommandId: "b" },
        { web: fact({ typecheck: "tsc --noEmit" }) },
      ),
    ).toMatchObject({ kind: "check", source: "package-script" });
  });

  it("ignores a configured command whose text is blank", () => {
    expect(
      inferVibeCheck(
        [
          component("web", [
            command("dev", "Dev", "npm run dev"),
            command("t", "Test", "   "),
          ]),
        ],
        { componentId: "web", runCommandId: "dev" },
        { web: fact({ test: "vitest run" }) },
      ),
    ).toMatchObject({
      kind: "check",
      command: "npm run test",
      source: "package-script",
    });
  });

  it("asks for package facts before declaring there is no check", () => {
    expect(
      inferVibeCheck([component("web")], { componentId: "web" }),
    ).toEqual({ kind: "needs-package-facts", componentIds: ["web"] });
  });

  // The whole priority ladder, each rung shadowed by every rung below it.
  const ladder: Array<{
    expected: string;
    scripts: Partial<Record<VibeCheckScript, string>>;
  }> = [
    {
      expected: "npm run check",
      scripts: {
        check: "npm run verify",
        typecheck: "tsc",
        test: "vitest run",
        build: "vite build",
      },
    },
    {
      expected: "npm run typecheck",
      scripts: { typecheck: "tsc", test: "vitest run", build: "vite build" },
    },
    {
      expected: "npm run tsc",
      scripts: { tsc: "tsc -b", test: "vitest run", build: "vite build" },
    },
    { expected: "npm run test", scripts: { test: "vitest run", build: "vite build" } },
    { expected: "npm run build", scripts: { build: "vite build" } },
  ];
  for (const rung of ladder) {
    it(`synthesises ${rung.expected} when it is the best script available`, () => {
      expect(
        inferVibeCheck([component("web")], { componentId: "web" }, {
          web: fact(rung.scripts),
        }),
      ).toMatchObject({
        kind: "check",
        command: rung.expected,
        source: "package-script",
      });
    });
  }

  it("uses the package manager the project declared", () => {
    expect(
      inferVibeCheck([component("web")], { componentId: "web" }, {
        web: fact({ typecheck: "tsc" }, "pnpm"),
      }),
    ).toMatchObject({ kind: "check", command: "pnpm run typecheck" });
  });

  it("skips npm's placeholder test script and falls through to build", () => {
    expect(
      inferVibeCheck([component("web")], { componentId: "web" }, {
        web: fact({
          test: 'echo "Error: no test specified" && exit 1',
          build: "vite build",
        }),
      }),
    ).toMatchObject({ kind: "check", command: "npm run build" });
  });

  it("skips a watch-mode script that would never report", () => {
    expect(
      inferVibeCheck([component("web")], { componentId: "web" }, {
        web: fact({ typecheck: "tsc --watch", test: "vitest", build: "vite build" }),
      }),
    ).toMatchObject({ kind: "check", command: "npm run build" });
  });

  it("keeps a non-watching vitest script", () => {
    expect(
      inferVibeCheck([component("web")], { componentId: "web" }, {
        web: fact({ test: "vitest run --coverage" }),
      }),
    ).toMatchObject({ kind: "check", command: "npm run test" });
  });
});

describe("inferVibeCheck when no check exists", () => {
  it("explains a project with no check script instead of returning null", () => {
    const result = inferVibeCheck([component("web")], { componentId: "web" }, {
      web: fact({}),
    });
    expect(result).toMatchObject({ kind: "none", gap: "no-script" });
    expect(result.kind === "none" && result.caveat).toBe(
      "WEB has no check, typecheck, test or build script, so there's no check I can run — turns here stay unverified until you add one.",
    );
  });

  it("explains a missing package.json", () => {
    const result = inferVibeCheck([component("web")], { componentId: "web" }, {
      web: { status: "missing" },
    });
    expect(result).toMatchObject({ kind: "none", gap: "no-package" });
    expect(result.kind === "none" && result.caveat).toContain("no package.json");
  });

  it("explains a package.json it could not read", () => {
    for (const status of ["invalid", "error"] as const) {
      const result = inferVibeCheck([component("web")], { componentId: "web" }, {
        web: { status },
      });
      expect(result).toMatchObject({ kind: "none", gap: "unreadable-package" });
      expect(result.kind === "none" && result.caveat).toContain("couldn't read");
    }
  });

  it("explains why a placeholder-only test script was refused", () => {
    const result = inferVibeCheck([component("web")], { componentId: "web" }, {
      web: fact({ test: 'echo "Error: no test specified" && exit 1' }),
    });
    expect(result).toMatchObject({ kind: "none", gap: "unusable-script" });
    expect(result.kind === "none" && result.caveat).toBe(
      "WEB's test script can't serve as a check (test is npm's placeholder that always fails, not a real test), so turns here stay unverified until one runs once and exits.",
    );
  });

  it("lists every refused script and its reason", () => {
    const result = inferVibeCheck([component("web")], { componentId: "web" }, {
      web: fact({
        test: 'echo "Error: no test specified" && exit 1',
        build: "vite build --watch",
      }),
    });
    expect(result).toMatchObject({ kind: "none", gap: "unusable-script" });
    expect(result.kind === "none" && result.caveat).toContain(
      "test and build scripts",
    );
    expect(result.kind === "none" && result.caveat).toContain("watches for changes");
  });

  it("explains a component that is not in the project", () => {
    expect(
      inferVibeCheck([component("web")], { componentId: "gone" }),
    ).toMatchObject({ kind: "none", gap: "no-component" });
  });

  it("never fabricates a command in any gap case", () => {
    const gaps = [
      inferVibeCheck([component("web")], { componentId: "gone" }),
      inferVibeCheck([component("web")], { componentId: "web" }, {
        web: { status: "missing" },
      }),
      inferVibeCheck([component("web")], { componentId: "web" }, { web: fact({}) }),
    ];
    for (const result of gaps) {
      expect(result.kind).toBe("none");
      expect(result).not.toHaveProperty("command");
      expect(result.kind === "none" && result.caveat.length).toBeGreaterThan(20);
    }
  });
});

describe("inferVibeCheck synthesised command ids", () => {
  const facts = { web: fact({ typecheck: "tsc" }) } satisfies VibeCheckPackageFacts;

  it("is deterministic across calls", () => {
    const components = [component("web")];
    expect(inferVibeCheck(components, { componentId: "web" }, facts)).toEqual(
      inferVibeCheck(components, { componentId: "web" }, facts),
    );
  });

  it("mints a vibe-namespaced id that no configured command already holds", () => {
    const result = inferVibeCheck([component("web")], { componentId: "web" }, facts);
    expect(result).toMatchObject({
      kind: "check",
      selection: {
        addCommand: { name: "Typecheck", command: "npm run typecheck" },
      },
    });
    expect(
      result.kind === "check" ? result.selection.runCommandId : "",
    ).toMatch(/^vibe-[0-9a-z]+$/);
  });

  it("finds its own persisted synthesis again as a configured command", () => {
    const first = inferVibeCheck([component("web")], { componentId: "web" }, facts);
    const id = first.kind === "check" ? first.selection.runCommandId : "";
    expect(
      inferVibeCheck(
        [component("web", [command(id, "Typecheck", "npm run typecheck")])],
        { componentId: "web" },
        facts,
      ),
    ).toEqual({
      kind: "check",
      selection: { componentId: "web", runCommandId: id },
      command: "npm run typecheck",
      source: "existing-command",
    });
  });

  it("adopts an identical command on the collided id instead of duplicating it", () => {
    // Contrived on purpose: the run command is *named* Typecheck, so the
    // configured branch excludes every command with that name and synthesis
    // runs anyway — straight onto an id that already holds the same text.
    const first = inferVibeCheck([component("web")], { componentId: "web" }, facts);
    const id = first.kind === "check" ? first.selection.runCommandId : "";
    const second = inferVibeCheck(
      [
        component("web", [
          command("dev", "Typecheck", "npm run dev"),
          command(id, "Typecheck", "npm run typecheck"),
        ]),
      ],
      { componentId: "web", runCommandId: "dev" },
      facts,
    );
    expect(second).toEqual({
      kind: "check",
      selection: { componentId: "web", runCommandId: id },
      command: "npm run typecheck",
      source: "package-script",
    });
  });

  it("steps past an id another command already occupies", () => {
    const first = inferVibeCheck([component("web")], { componentId: "web" }, facts);
    const id = first.kind === "check" ? first.selection.runCommandId : "";
    const second = inferVibeCheck(
      [component("web", [command(id, "Something else", "make all")])],
      { componentId: "web" },
      facts,
    );
    expect(second.kind === "check" && second.selection.runCommandId).not.toBe(id);
    expect(second).toMatchObject({
      kind: "check",
      command: "npm run typecheck",
      selection: { addCommand: { command: "npm run typecheck" } },
    });
  });
});

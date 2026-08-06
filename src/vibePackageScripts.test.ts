import { describe, expect, it } from "vitest";
import type { Component } from "./projects";
import { inferVibeCheck } from "./vibeCheckInference";
import { parseVibePackageFact } from "./vibePackageScripts";

const packageJson = (scripts: Record<string, string>, packageManager?: string) =>
  JSON.stringify({ scripts, ...(packageManager ? { packageManager } : {}) });

describe("parseVibePackageFact", () => {
  it("still answers what runs the app", () => {
    const fact = parseVibePackageFact(packageJson({ dev: "vite", start: "node ." }));
    expect(fact).toMatchObject({
      status: "loaded",
      scripts: { dev: "vite", start: "node ." },
      runner: "npm",
    });
  });

  it("carries the check-ish scripts a fact used to discard", () => {
    // The whole reason `verified` was unreachable: this narrowed `scripts` to
    // dev/start, so a fact could never carry a check and `inferVibeCheck` was
    // structurally guaranteed to find none.
    const fact = parseVibePackageFact(
      packageJson({
        dev: "vite",
        check: "npm run typecheck && npm test",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        build: "vite build",
        lint: "eslint .",
      }),
    );
    expect(fact).toMatchObject({
      status: "loaded",
      scripts: {
        dev: "vite",
        check: "npm run typecheck && npm test",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        build: "vite build",
      },
    });
    // `lint` is deliberately not a check: a style opinion is not evidence the
    // app is broken, and carrying it would hold `verified` hostage to it.
    expect(fact).toMatchObject({ scripts: expect.not.objectContaining({ lint: expect.anything() }) });
  });

  it("omits an absent script rather than storing an explicit undefined", () => {
    const fact = parseVibePackageFact(packageJson({ dev: "vite" }));
    expect(fact.status === "loaded" && "typecheck" in fact.scripts).toBe(false);
  });

  it("keeps the declared package manager", () => {
    expect(parseVibePackageFact(packageJson({ dev: "vite" }, "pnpm@9.1.0"))).toMatchObject({
      runner: "pnpm",
    });
  });

  it("reports invalid JSON rather than an empty fact", () => {
    expect(parseVibePackageFact("{ not json")).toEqual({ status: "invalid" });
  });
});

describe("the loader and the check inference together", () => {
  const component: Component = {
    id: "app",
    label: "App",
    path: "/repo",
    commands: [{ id: "dev", name: "Dev", command: "npm run dev" }],
  } as Component;

  it("reaches a real check for a project whose only check is a package script", () => {
    const facts = {
      app: parseVibePackageFact(
        packageJson({ dev: "vite", typecheck: "tsc --noEmit" }, "pnpm@9"),
      ),
    };
    const inference = inferVibeCheck(
      [component],
      { componentId: "app", runCommandId: "dev" },
      facts,
    );
    expect(inference).toMatchObject({
      kind: "check",
      command: "pnpm run typecheck",
      source: "package-script",
    });
  });

  it("still explains the gap when the package really has no check", () => {
    const facts = { app: parseVibePackageFact(packageJson({ dev: "vite" })) };
    const inference = inferVibeCheck(
      [component],
      { componentId: "app", runCommandId: "dev" },
      facts,
    );
    expect(inference).toMatchObject({ kind: "none", gap: "no-script" });
    expect(inference.kind === "none" && inference.caveat).toContain(
      "turns here stay unverified",
    );
  });
});

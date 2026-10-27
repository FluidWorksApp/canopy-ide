import { describe, expect, it } from "vitest";
import { customChecks, detectChecks, touchesManifest } from "./detect";

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scripts, ...extra });

describe("detectChecks", () => {
  it("takes test, typecheck and lint scripts, test first, with the right package manager", () => {
    const checks = detectChecks({
      entries: ["package.json", "pnpm-lock.yaml"],
      packageJson: pkg({ lint: "oxlint", typecheck: "tsc -b", test: "vitest run", dev: "vite" }),
    });
    expect(checks.map((c) => [c.kind, c.argv.join(" "), c.runner])).toEqual([
      ["test", "pnpm run test", "vitest"],
      ["typecheck", "pnpm run typecheck", undefined],
      ["lint", "pnpm run lint", undefined],
    ]);
  });

  it("prefers a declared packageManager and infers jest from dependencies", () => {
    const [test] = detectChecks({
      entries: ["package.json", "yarn.lock"],
      packageJson: pkg({ test: "react-scripts test" }, { packageManager: "bun@1.1.0", devDependencies: { jest: "^29" } }),
    });
    expect(test.argv).toEqual(["bun", "run", "test"]);
    expect(test.runner).toBe("jest");
  });

  it("skips npm's placeholder and watch-mode scripts", () => {
    expect(
      detectChecks({ entries: ["package.json"], packageJson: pkg({ test: 'echo "Error: no test specified" && exit 1' }) }),
    ).toEqual([]);
    expect(detectChecks({ entries: ["package.json"], packageJson: pkg({ test: "jest --watch" }) })).toEqual([]);
  });

  it("detects Cargo, Go and pytest projects, including mixed ones", () => {
    const checks = detectChecks({
      entries: ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"],
      packageJson: pkg({ test: "vitest run" }),
      cargoToml: "[workspace]\nmembers = [\"a\"]\n",
      pyproject: "[tool.pytest.ini_options]\naddopts = \"-q\"\n",
    });
    expect(checks.map((c) => c.argv.join(" "))).toEqual([
      "npm run test",
      "cargo test --workspace",
      "go test ./...",
      "python3 -m pytest -q",
    ]);
    expect(detectChecks({ entries: ["tests", "requirements.txt"] }, "windows")[0].argv[0]).toBe("python");
  });

  it("falls back to a Makefile only when nothing else declares tests", () => {
    expect(detectChecks({ entries: ["Makefile"], makefile: "build:\n\tcc x.c\ntest: build\n\t./t\n" })[0].argv).toEqual(["make", "test"]);
    expect(detectChecks({ entries: ["Makefile"], makefile: "check:\n\t./c\n" })[0].argv).toEqual(["make", "check"]);
    // `test := 1` is a variable, not a target.
    expect(detectChecks({ entries: ["Makefile"], makefile: "test := 1\n" })).toEqual([]);
    const both = detectChecks({ entries: ["Makefile", "go.mod"], makefile: "test:\n\tgo test\n" });
    expect(both.map((c) => c.id)).toEqual(["go:test"]);
  });

  it("ignores an unparsable package.json", () => {
    expect(detectChecks({ entries: ["package.json"], packageJson: "{ nope" })).toEqual([]);
  });
});

describe("customChecks", () => {
  it("runs each line through the shell and holds test-ish lines to the zero-test rule", () => {
    const [a, b] = customChecks(["npm test -- --run", "  ", "make lint"]);
    expect(a).toMatchObject({ kind: "test", argv: ["/bin/sh", "-c", "npm test -- --run"], source: "custom" });
    expect(b.kind).toBe("check");
    expect(customChecks(["pytest"], "windows")[0].argv).toEqual(["pytest"]);
  });
});

describe("touchesManifest", () => {
  it("notices a changed manifest so detection is redone", () => {
    expect(touchesManifest(["src/a.ts", "package.json"])).toBe(true);
    expect(touchesManifest(["/abs/repo/go.mod"])).toBe(true);
    expect(touchesManifest(["src/package.ts"])).toBe(false);
  });
});

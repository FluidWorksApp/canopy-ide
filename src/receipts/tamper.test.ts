import { describe, expect, it } from "vitest";
import { detectTamper, isTestFile, parseUnifiedDiff, tampered } from "./tamper";

const PATCH = `diff --git a/src/sum.test.ts b/src/sum.test.ts
index 1..2 100644
--- a/src/sum.test.ts
+++ b/src/sum.test.ts
@@ -1,4 +1,4 @@
 it("adds", () => {
-  expect(sum(1, 2)).toBe(3);
+  expect(sum(1, 2)).toBeGreaterThan(0);
 });
diff --git a/src/sum.ts b/src/sum.ts
--- a/src/sum.ts
+++ b/src/sum.ts
@@ -1 +1 @@
-export const sum = (a, b) => a - b;
+export const sum = (a, b) => a + b;
diff --git a/pkg/thing_test.go b/pkg/thing_test.go
--- a/pkg/thing_test.go
+++ b/pkg/thing_test.go
@@ -3,2 +3,3 @@
 func TestThing(t *testing.T) {
+	t.Skip("flaky")
diff --git a/tests/test_new.py b/tests/test_new.py
new file mode 100644
--- /dev/null
+++ b/tests/test_new.py
@@ -0,0 +1,2 @@
+def test_new():
+    assert f() == 1
diff --git a/old.spec.js b/old.spec.js
deleted file mode 100644
--- a/old.spec.js
+++ /dev/null
@@ -1,2 +0,0 @@
-it("x", () => {
-  expect(x).toBe(1);
`;

describe("isTestFile", () => {
  it("recognises test files across ecosystems", () => {
    for (const p of ["src/a.test.ts", "src/__tests__/a.tsx", "pkg/x_test.go", "tests/test_a.py", "a_test.py", "tests/integration.rs", "web/b.spec.jsx", "src/__snapshots__/a.snap"])
      expect(isTestFile(p), p).toBe(true);
    for (const p of ["src/testing.ts", "src/contest.py", "src/attest.go", "README.md"]) expect(isTestFile(p), p).toBe(false);
  });
});

describe("detectTamper", () => {
  const diffs = parseUnifiedDiff(PATCH);
  const flags = detectTamper(["src/sum.test.ts", "src/sum.ts"], diffs);
  const by = (path: string) => flags.find((f) => f.path === path);

  it("parses files, including created and deleted ones", () => {
    expect(diffs.map((d) => d.path)).toEqual(["src/sum.test.ts", "src/sum.ts", "pkg/thing_test.go", "tests/test_new.py", "old.spec.js"]);
    expect(diffs[3].created).toBe(true);
    expect(diffs[4].deleted).toBe(true);
  });

  it("flags a rewritten assertion for a human look", () => {
    expect(by("src/sum.test.ts")).toMatchObject({ severity: "review", reason: "assertions-changed" });
    expect(by("src/sum.test.ts")!.lines).toContain("- expect(sum(1, 2)).toBe(3);");
  });

  it("flags a disabled test and a deleted test file", () => {
    expect(by("pkg/thing_test.go")).toMatchObject({ severity: "review", reason: "test-disabled" });
    expect(by("old.spec.js")).toMatchObject({ severity: "review", reason: "test-deleted" });
  });

  it("only notes a new test file that changes no existing assertion", () => {
    expect(by("tests/test_new.py")).toMatchObject({ severity: "note", reason: "tests-added" });
  });

  it("never flags source files", () => {
    expect(by("src/sum.ts")).toBeUndefined();
    expect(tampered(flags)).toBe(true);
  });

  it("names a journaled test file the diff did not show", () => {
    const only = detectTamper(["/repo/src/other.test.ts"], []);
    expect(only).toEqual([expect.objectContaining({ path: "/repo/src/other.test.ts", severity: "note", reason: "test-file-touched" })]);
    expect(tampered(only)).toBe(false);
  });

  it("a test file edited without touching assertions is a note", () => {
    const d = parseUnifiedDiff(`diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@\n-import { a } from "./a";\n+import { a } from "./a.js";\n`);
    expect(detectTamper([], d)[0]).toMatchObject({ severity: "note", reason: "test-file-touched" });
  });
});

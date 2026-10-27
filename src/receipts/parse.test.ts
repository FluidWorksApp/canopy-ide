import { describe, expect, it } from "vitest";
import { classify, parseOutput, tail } from "./parse";

const VITEST_PASS = `
 ✓ src/a.test.ts (3 tests) 12ms
 ✓ src/b.test.ts (9 tests) 30ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  10:00:00
   Duration  1.20s
`;
const VITEST_FAIL = `
 FAIL  src/a.test.ts > sums > adds
AssertionError: expected 3 to be 4

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 11 passed (12)
`;
const VITEST_NONE = `
No test files found, exiting with code 1
include: **/*.{test,spec}.?(c|m)[jt]s?(x)
`;
const JEST_FAIL = `
  ● sums › adds

    expect(received).toBe(expected)

Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 2 skipped, 11 passed, 14 total
Snapshots:   0 total
`;
const JEST_NONE = `No tests found, exiting with code 0\nRan all test suites.`;
const CARGO = `
running 3 tests
test a::works ... ok
test a::fails ... FAILED
test a::other ... ok

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

running 4 tests
test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
const CARGO_NONE = `
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
const PYTEST = `
FAILED tests/test_math.py::test_add - assert 3 == 4
========================= 1 failed, 10 passed, 1 skipped in 0.12s =========================
`;
const PYTEST_NONE = `
collected 0 items

========================= no tests ran in 0.01s =========================
`;
const GO = `
ok  	example.com/a	0.012s
FAIL	example.com/b	0.020s
?   	example.com/c	[no test files]
`;
const GO_NONE = `
?   	example.com/a	[no test files]
?   	example.com/b	[no test files]
`;
const GO_V = `
=== RUN   TestA
--- PASS: TestA (0.00s)
=== RUN   TestB
--- FAIL: TestB (0.00s)
FAIL
FAIL	example.com/a	0.010s
`;

describe("parseOutput", () => {
  it("reads vitest passes, failures and its no-test-files exit", () => {
    expect(parseOutput(VITEST_PASS).counts).toMatchObject({ passed: 12, failed: 0, total: 12 });
    const fail = parseOutput(VITEST_FAIL, "vitest");
    expect(fail.counts).toMatchObject({ passed: 11, failed: 1, total: 12 });
    expect(fail.failures[0]).toContain("src/a.test.ts");
    expect(parseOutput(VITEST_NONE, "vitest")).toMatchObject({ runner: "vitest", zeroTests: true });
  });

  it("reads jest's summary and its 'No tests found'", () => {
    const r = parseOutput(JEST_FAIL, "jest");
    expect(r.counts).toMatchObject({ passed: 11, failed: 1, skipped: 2, total: 14 });
    expect(r.failures).toEqual(["sums › adds"]);
    expect(parseOutput(JEST_NONE, "jest").zeroTests).toBe(true);
  });

  it("sums cargo's per-binary results and spots an empty crate", () => {
    const r = parseOutput(CARGO);
    expect(r.runner).toBe("cargo");
    expect(r.counts).toMatchObject({ passed: 6, failed: 1, skipped: 1 });
    expect(r.failures).toEqual(["a::fails"]);
    expect(parseOutput(CARGO_NONE).zeroTests).toBe(true);
  });

  it("reads pytest's summary and 'no tests ran'", () => {
    const r = parseOutput(PYTEST);
    expect(r).toMatchObject({ runner: "pytest", zeroTests: false });
    expect(r.counts).toMatchObject({ passed: 10, failed: 1, skipped: 1 });
    expect(r.failures).toEqual(["tests/test_math.py::test_add"]);
    expect(parseOutput(PYTEST_NONE).zeroTests).toBe(true);
  });

  it("counts go packages, and treats all-[no test files] as zero tests", () => {
    const r = parseOutput(GO);
    expect(r.counts).toMatchObject({ passed: 1, failed: 1, skipped: 1, unit: "packages" });
    expect(parseOutput(GO_NONE)).toMatchObject({ runner: "go", zeroTests: true });
    const v = parseOutput(GO_V, "go");
    expect(v.counts).toMatchObject({ passed: 1, failed: 1, unit: "tests" });
    expect(v.failures).toEqual(["TestB"]);
  });

  it("strips colour codes before reading", () => {
    expect(parseOutput("\u001b[32m      Tests  \u001b[1m3 passed\u001b[22m (3)\u001b[39m").counts?.passed).toBe(3);
  });

  it("returns no counts for output it does not know", () => {
    expect(parseOutput("Found 0 errors.")).toMatchObject({ runner: "unknown", counts: null });
  });
});

describe("classify", () => {
  const parsed = (o: string) => parseOutput(o);
  it("a green exit with zero tests is not a pass", () => {
    expect(classify({ kind: "test", exitCode: 0, timedOut: false, spawnError: null, parsed: parsed(GO_NONE) })).toBe("no-tests");
    expect(classify({ kind: "test", exitCode: 0, timedOut: false, spawnError: null, parsed: parsed(JEST_NONE) })).toBe("no-tests");
  });
  it("pytest's exit 5 means nothing was collected", () => {
    expect(classify({ kind: "test", exitCode: 5, timedOut: false, spawnError: null, parsed: parsed("") })).toBe("failed");
    expect(classify({ kind: "test", exitCode: 5, timedOut: false, spawnError: null, parsed: parsed(""), runner: "pytest" })).toBe("no-tests");
    expect(classify({ kind: "test", exitCode: 5, timedOut: false, spawnError: null, parsed: parsed(PYTEST_NONE) })).toBe("no-tests");
  });
  it("a timeout is timed out, never failed", () => {
    expect(classify({ kind: "test", exitCode: null, timedOut: true, spawnError: null, parsed: parsed(VITEST_FAIL) })).toBe("timed-out");
  });
  it("could-not-start is its own outcome", () => {
    expect(classify({ kind: "lint", exitCode: null, timedOut: false, spawnError: "ENOENT", parsed: parsed("") })).toBe("not-run");
  });
  it("failures win over a zero exit, and a typecheck needs no test count", () => {
    expect(classify({ kind: "test", exitCode: 0, timedOut: false, spawnError: null, parsed: parsed(CARGO) })).toBe("failed");
    expect(classify({ kind: "typecheck", exitCode: 0, timedOut: false, spawnError: null, parsed: parsed("") })).toBe("passed");
    expect(classify({ kind: "typecheck", exitCode: 2, timedOut: false, spawnError: null, parsed: parsed("") })).toBe("failed");
  });
});

describe("tail", () => {
  it("keeps the last lines, uncoloured", () => {
    const text = Array.from({ length: 100 }, (_, i) => `\u001b[31mline${i}\u001b[0m`).join("\n");
    const t = tail(text, 3);
    expect(t).toBe("line97\nline98\nline99");
  });
});

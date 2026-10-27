import { describe, expect, it } from "vitest";
import { combineStatus, workspaceCeiling } from "./status";
import type { CheckResult, PackageCheck, TamperFlag } from "./types";

const check = (outcome: CheckResult["outcome"], label = "Tests"): CheckResult => ({
  id: label,
  label,
  kind: "test",
  command: "npm run test",
  exitCode: outcome === "passed" ? 0 : 1,
  outcome,
  counts: null,
  durationMs: 1000,
  outputTail: "",
  failures: [],
});
const review: TamperFlag = { path: "a.test.ts", severity: "review", reason: "assertions-changed", detail: "", lines: [] };
const note: TamperFlag = { ...review, severity: "note", reason: "tests-added" };
const unknownPkg: PackageCheck = { ecosystem: "npm", name: "left-padz", status: "unknown", manifest: "package.json" };

describe("workspaceCeiling", () => {
  it("is proven only when at least one check ran and all passed", () => {
    expect(workspaceCeiling([check("passed")], []).ceiling).toBe("proven");
    expect(workspaceCeiling([], []).ceiling).toBe("partial");
  });
  it("a failure caps at unproven; zero tests, timeouts and unknown packages cap at partial", () => {
    expect(workspaceCeiling([check("passed"), check("failed", "Lint")], []).ceiling).toBe("unproven");
    expect(workspaceCeiling([check("no-tests")], []).ceiling).toBe("partial");
    expect(workspaceCeiling([check("timed-out")], []).ceiling).toBe("partial");
    expect(workspaceCeiling([check("passed")], [unknownPkg]).ceiling).toBe("partial");
    expect(workspaceCeiling([check("not-run")], []).ceiling).toBe("partial");
  });
  it("says why, calling a timeout a timeout", () => {
    expect(workspaceCeiling([check("timed-out")], []).reasons.join(" ")).toMatch(/timed out \(not counted as a failure\)/);
    expect(workspaceCeiling([check("no-tests")], []).reasons.join(" ")).toMatch(/zero tests/);
  });
});

describe("combineStatus", () => {
  it("the brain can lower the ceiling but never raise it", () => {
    expect(combineStatus("proven", "proven", [])).toBe("proven");
    expect(combineStatus("proven", "partial", [])).toBe("partial");
    expect(combineStatus("unproven", "proven", [])).toBe("unproven");
    expect(combineStatus("partial", "proven", [])).toBe("partial");
  });
  it("contradicted stands whatever the ceiling", () => {
    expect(combineStatus("proven", "contradicted", [])).toBe("contradicted");
  });
  it("without a verdict, passing checks reach partial, not proven", () => {
    expect(combineStatus("proven", null, [])).toBe("partial");
    expect(combineStatus("unproven", null, [])).toBe("unproven");
  });
  it("a changed assertion is never proven, but does not hide a failure", () => {
    expect(combineStatus("proven", "proven", [review])).toBe("tests-changed");
    expect(combineStatus("partial", "partial", [review])).toBe("tests-changed");
    expect(combineStatus("unproven", "proven", [review])).toBe("unproven");
    expect(combineStatus("proven", "proven", [note])).toBe("proven");
  });
});

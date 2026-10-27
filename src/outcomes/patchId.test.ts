import { describe, expect, it } from "vitest";
import { findLanding, fingerprint, fingerprintKey, sameFingerprint } from "./patchId";

const diff = (file: string, lines: string[]) =>
  [`diff --git a/${file} b/${file}`, "index 1111111..2222222 100644", `--- a/${file}`, `+++ b/${file}`, "@@ -1,2 +1,3 @@", ...lines].join("\n");

describe("content fingerprints", () => {
  it("ignores positions, blob ids and whitespace", () => {
    const a = fingerprint(diff("a.ts", ["+const x = 1;", "-old()"]));
    const b = fingerprint(diff("a.ts", ["-old( )", "+const  x=1;"]).replace("@@ -1,2 +1,3 @@", "@@ -40,2 +40,3 @@").replace("1111111", "9999999"));
    expect(sameFingerprint(a, b)).toBe(true);
    expect(fingerprintKey(a)).toBe(fingerprintKey(b));
  });

  it("a line added then removed cancels out", () => {
    expect(fingerprint(`${diff("a.ts", ["+tmp"])}\n${diff("a.ts", ["-tmp"])}`).size).toBe(0);
  });

  it("finds a run of rebased commits whose sum is the PR, after unrelated ones", () => {
    const pr = fingerprint(diff("a.ts", ["+two", "+three"]));
    const commits = [
      { id: "x", fp: fingerprint(diff("c.ts", ["+unrelated"])) },
      { id: "r1", fp: fingerprint(diff("a.ts", ["+two", "+tmp"])) },
      { id: "r2", fp: fingerprint(diff("a.ts", ["+three", "-tmp"])) },
      { id: "y", fp: fingerprint(diff("a.ts", ["+four"])) },
    ];
    const hit = findLanding(pr, commits);
    expect(hit?.first.id).toBe("r1");
    expect(hit?.last.id).toBe("r2");
    expect(findLanding(fingerprint(diff("a.ts", ["+never"])), commits)).toBeNull();
    expect(findLanding(new Map(), commits)).toBeNull();
  });
});

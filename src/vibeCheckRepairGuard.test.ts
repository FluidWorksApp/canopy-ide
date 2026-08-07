/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

/** The behaviour these guard is the one the person named as the whole problem:
 *  "you just try to run the command and then it fails after three times and
 *  then just suffice to say it failed — that is not a Vibe building where you
 *  have not a single person in the seat."
 *
 *  Structural rather than behavioural because verifyTurn is private and reached
 *  only through a full turn with a live runner; what matters here is that the
 *  wiring exists and is ordered correctly, which the source states plainly. */
describe("a failed check is diagnosed, not reported", () => {
  const source = read("src/vibeBuilderSession.ts");
  const verify = source.slice(
    source.indexOf("private async verifyTurn"),
    source.indexOf("private async repairFailedCheck"),
  );

  it("hands the captured output to repair before judging the turn failed", () => {
    // The shipped failure: `pnpm run build` exited 1, the output said
    // "node_modules missing, did you mean to install?", and Canopy wrote it to
    // an artifact and reported "Verification found a problem".
    expect(verify).toContain("repairFailedCheck(check.output");
    const repairAt = verify.indexOf("repairFailedCheck(");
    const summaryAt = verify.indexOf("verificationSummary(");
    expect(repairAt).toBeGreaterThan(-1);
    // Repair has to happen before the summary is composed, or the person is
    // told it failed while Canopy is still fixing it.
    if (summaryAt > -1) expect(repairAt).toBeLessThan(summaryAt);
  });

  it("only re-runs the check when something actually changed", () => {
    const repair = source.slice(
      source.indexOf("private async repairFailedCheck"),
      source.indexOf("private launchSpec"),
    );
    // The second run is gated on the repair agent reporting a fix. Re-running
    // a command that nothing has changed is the blind-retry pattern.
    const fixedGate = repair.indexOf("result.verdict.fixed");
    const rerun = repair.indexOf(".runCheck(");
    expect(fixedGate).toBeGreaterThan(-1);
    expect(rerun).toBeGreaterThan(fixedGate);
  });

  it("re-judges against the second observation rather than assuming success", () => {
    // A repair agent saying "fixed" is a claim. The verdict must come from
    // running the check again, not from believing it.
    expect(verify).toContain("judgeVerification(contract, observations)");
    expect(verify).toContain("observations[0] = retried.observation");
  });

  it("says what it learned even when it could not fix it", () => {
    const repair = source.slice(
      source.indexOf("private async repairFailedCheck"),
      source.indexOf("private launchSpec"),
    );
    expect(repair).toContain("result.verdict.diagnosis");
    expect(repair).toContain("blocker");
  });

  it("keeps both observations in the ledger", () => {
    // Only keeping the ending would erase the evidence that anything was
    // repaired, which is the part worth auditing.
    const appends = verify.split("kind: \"verification.observation\"").length - 1;
    expect(appends).toBeGreaterThanOrEqual(2);
  });
});

describe("the Build executor can make its change actually run", () => {
  const source = read("src/vibeBuilderSession.ts");

  it("takes its authority from the one place authority is decided", () => {
    expect(source).toContain('grantFor("build"');
    const spec = source.slice(
      source.indexOf("private launchSpec"),
      source.indexOf("private async handleAttemptFailure"),
    );
    const prompt = spec.slice(
      spec.indexOf("systemPromptAppend"),
      spec.indexOf("permissionMode"),
    );
    // The capped-by-design instruction this replaced: told not to use a shell,
    // a turn could add a dependency to package.json and had no way to install
    // it, so the change it had just written could never run.
    expect(prompt).not.toContain("do not use a shell");
    expect(prompt).toContain("install what it needs");
  });

  it("passes the sandbox what the grant promises", () => {
    const spec = source.slice(
      source.indexOf("private launchSpec"),
      source.indexOf("private async handleAttemptFailure"),
    );
    expect(spec).toContain("network: grant.network");
    expect(spec).toContain("writableRoots: grant.writableRoots");
    expect(spec).toContain("allowedTools: grant.allowedTools");
    expect(spec).toContain("authority: grant.authority");
  });
});

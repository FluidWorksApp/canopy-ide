import { describe, expect, it } from "vitest";
import {
  capturedNetworkObservation,
  judgeVerification,
  networkObservation,
  PERF_LIMITS,
  type VerificationObservation,
} from "./vibeVerification";

const T = 1_700_000_000_000;
const ob = (
  kind: VerificationObservation["kind"],
  verdict: VerificationObservation["verdict"],
  at = T,
): VerificationObservation => ({ kind, verdict, note: "", at });

const CONTRACT = { required: ["check", "server", "console"] as const };

describe("judgeVerification", () => {
  it("verifies only when every required kind explicitly passed", () => {
    const v = judgeVerification(
      { required: [...CONTRACT.required] },
      [ob("check", "pass"), ob("server", "pass"), ob("console", "pass")],
    );
    expect(v).toEqual({ outcome: "verified", missing: [], failures: [] });
  });

  it("an absent observation is incomplete, never a quiet pass", () => {
    const v = judgeVerification(
      { required: [...CONTRACT.required] },
      [ob("check", "pass"), ob("server", "pass")],
    );
    expect(v.outcome).toBe("incomplete");
    expect(v.missing).toEqual(["console"]);
  });

  it("an unknown observation is incomplete too — job_done is not evidence", () => {
    const v = judgeVerification(
      { required: [...CONTRACT.required] },
      [ob("check", "pass"), ob("server", "pass"), ob("console", "unknown")],
    );
    expect(v.outcome).toBe("incomplete");
  });

  it("any failure fails the whole verdict and is reported", () => {
    const v = judgeVerification(
      { required: [...CONTRACT.required] },
      [ob("check", "fail"), ob("server", "pass"), ob("console", "pass")],
    );
    expect(v.outcome).toBe("failed");
    expect(v.failures).toHaveLength(1);
  });

  it("a re-run pass supersedes an earlier fail, but unknown never does", () => {
    const rerun = judgeVerification(
      { required: ["check"] },
      [ob("check", "fail", T), ob("check", "pass", T + 1)],
    );
    expect(rerun.outcome).toBe("verified");
    const smudge = judgeVerification(
      { required: ["check"] },
      [ob("check", "fail", T), ob("check", "unknown", T + 1)],
    );
    expect(smudge.outcome).toBe("failed");
  });
});

describe("networkObservation", () => {
  const s = (over: Partial<Parameters<typeof networkObservation>[0][0]>) => ({
    url: "/api/x",
    ms: 100,
    bytes: 1000,
    failed: false,
    ...over,
  });

  it("failed requests fail the observation", () => {
    expect(networkObservation([s({ failed: true })], T).verdict).toBe("fail");
  });

  it("perf outliers pass but say so — evidence, not a vibe", () => {
    const o = networkObservation([s({ ms: PERF_LIMITS.slowMs })], T);
    expect(o.verdict).toBe("pass");
    expect(o.note).toContain("outlier");
  });

  it("a clean sample set passes quietly", () => {
    expect(networkObservation([s({})], T).note).toContain("no failed");
  });

  it("converts page-capture requests into independent evidence", () => {
    expect(
      capturedNetworkObservation(
        [{ url: "/api/orders", status: 200, ms: 20, bytes: 1200 }],
        T,
      ),
    ).toMatchObject({ kind: "network", verdict: "pass" });
    expect(
      capturedNetworkObservation(
        [{ url: "/api/orders", status: 500, ms: 20, bytes: 100 }],
        T,
      ),
    ).toMatchObject({ kind: "network", verdict: "fail" });
  });
});

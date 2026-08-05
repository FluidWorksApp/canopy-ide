import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_POLICY,
  autoReviewedHead,
  loadReviewPolicy,
  parseReviewPolicy,
  rememberAutoReviewedHead,
  reviewPolicyJson,
  saveReviewPolicy,
  shouldAutoReview,
} from "./prPolicy";

describe("PR review policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("normalizes a complete policy and supplies safe defaults", () => {
    expect(parseReviewPolicy("{}")).toEqual(DEFAULT_REVIEW_POLICY);
    const policy = parseReviewPolicy(JSON.stringify({
      autoReview: true,
      reviewDrafts: true,
      diagrams: false,
      excludedPaths: ["dist/**"],
      pathInstructions: [{ path: "src/**", instructions: "Check cleanup." }],
      checks: [{ name: "Compatibility", instructions: "No API break.", severity: "error" }],
      learnings: ["Prefer regression tests."],
      relatedRepositories: ["/work/api"],
    }));
    expect(policy.autoReview).toBe(true);
    expect(policy.checks[0].severity).toBe("error");
    expect(parseReviewPolicy(reviewPolicyJson(policy))).toEqual(policy);
  });

  it("rejects malformed policy fields with an actionable path", () => {
    expect(() => parseReviewPolicy('{"autoReview":"yes"}')).toThrow(
      '"autoReview" must be true or false',
    );
    expect(() => parseReviewPolicy('{"checks":[{"name":"x"}]}')).toThrow(
      '"checks[0]"',
    );
    expect(() => parseReviewPolicy("[]")).toThrow("JSON object");
  });

  it("persists policy per repository", () => {
    const policy = { ...DEFAULT_REVIEW_POLICY, autoReview: true };
    saveReviewPolicy("/one", policy);
    expect(loadReviewPolicy("/one")).toEqual(policy);
    expect(loadReviewPolicy("/two")).toEqual(DEFAULT_REVIEW_POLICY);
  });

  it("records each head once for automatic private review", () => {
    expect(autoReviewedHead("/repo", 4)).toBe("");
    rememberAutoReviewedHead("/repo", 4, "abc");
    expect(autoReviewedHead("/repo", 4)).toBe("abc");
    rememberAutoReviewedHead("/repo", 4, "");
    expect(autoReviewedHead("/repo", 4)).toBe("");
  });

  it("auto-reviews one open head and respects draft and busy gates", () => {
    const policy = { ...DEFAULT_REVIEW_POLICY, autoReview: true };
    const open = {
      head: "def",
      state: "OPEN",
      draft: false,
      busy: false,
      lastHead: "abc",
    };
    expect(shouldAutoReview(policy, open)).toBe(true);
    expect(shouldAutoReview(policy, { ...open, lastHead: "def" })).toBe(false);
    expect(shouldAutoReview(policy, { ...open, busy: true })).toBe(false);
    expect(shouldAutoReview(policy, { ...open, draft: true })).toBe(false);
    expect(
      shouldAutoReview({ ...policy, reviewDrafts: true }, { ...open, draft: true }),
    ).toBe(true);
  });
});

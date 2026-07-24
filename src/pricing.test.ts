import { describe, expect, it } from "vitest";
import { estimateCost, sessionCost, type TokenUsage } from "./pricing";

const usage = (over: Partial<TokenUsage>): TokenUsage => ({
  model: "claude-opus-4",
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  ...over,
});

describe("estimateCost", () => {
  it("returns null when the model is unknown or unpriced", () => {
    expect(estimateCost(usage({ model: null }))).toBeNull();
    expect(estimateCost(usage({ model: "some-unlisted-model" }))).toBeNull();
  });

  it("prices input and output at the model's $/MTok rate", () => {
    // opus = { in: 5, out: 25 } per MTok.
    const cost = estimateCost(usage({ model: "opus", input_tokens: 1e6, output_tokens: 1e6 }));
    expect(cost).toBeCloseTo(5 + 25, 6);
  });

  it("charges cache-creation at 1.25x input and cache-read at 0.1x input", () => {
    // sonnet in = 3 /MTok. 1e6 cache-creation -> 3 * 1.25 = 3.75;
    // 1e6 cache-read -> 3 * 0.1 = 0.3.
    const cost = estimateCost(
      usage({ model: "sonnet", cache_creation_tokens: 1e6, cache_read_tokens: 1e6 }),
    );
    expect(cost).toBeCloseTo(3.75 + 0.3, 6);
  });

  it("matches the first pattern in order (opus before the openai families)", () => {
    // A name containing both would resolve to whichever regex sits first.
    expect(estimateCost(usage({ model: "claude-3-opus", input_tokens: 1e6 }))).toBeCloseTo(5, 6);
    expect(estimateCost(usage({ model: "gpt-4o", input_tokens: 1e6 }))).toBeCloseTo(2.5, 6);
    expect(estimateCost(usage({ model: "gemini-2.5-pro", input_tokens: 1e6 }))).toBeCloseTo(1.25, 6);
  });
});

describe("sessionCost", () => {
  it("prefers a CLI-reported cost over any estimate", () => {
    const s = { ...usage({ model: "opus", input_tokens: 1e9 }), cost: 0.42 };
    expect(sessionCost(s)).toBe(0.42);
  });

  it("treats a zero reported cost as authoritative (not falsy-fallback)", () => {
    const s = { ...usage({ model: "opus", input_tokens: 1e9 }), cost: 0 };
    expect(sessionCost(s)).toBe(0);
  });

  it("falls back to an estimate when no cost is reported", () => {
    const s = { ...usage({ model: "opus", input_tokens: 1e6 }), cost: null };
    expect(sessionCost(s)).toBeCloseTo(5, 6);
  });

  it("returns null when neither cost nor a priceable model is available", () => {
    expect(sessionCost({ ...usage({ model: null }) })).toBeNull();
  });
});

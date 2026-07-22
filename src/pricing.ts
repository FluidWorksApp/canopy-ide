// Rough cost estimation from token counts, shared by the status tray and the
// Statistics panel. Prices are $/MTok (input, output) and are ESTIMATES —
// published list prices by model family, not billed amounts. Cache-read is
// charged at ~0.1× input and cache-creation at ~1.25× input, matching
// Anthropic's ratios; other providers differ but land close enough for a
// running-total chip. When a CLI reports its own cost (omp), prefer that over
// any estimate (see sessionCost).

export interface TokenUsage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

// First matching pattern wins, so list more specific names before families.
const PRICING: [RegExp, { in: number; out: number }][] = [
  // Anthropic
  [/fable|mythos/i, { in: 10, out: 50 }],
  [/opus/i, { in: 5, out: 25 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku/i, { in: 1, out: 5 }],
  // OpenAI (Codex)
  [/gpt-5\.?5|gpt-5/i, { in: 1.25, out: 10 }],
  [/o4|o3|o1/i, { in: 2, out: 8 }],
  [/gpt-4\.1/i, { in: 2, out: 8 }],
  [/gpt-4o/i, { in: 2.5, out: 10 }],
  // Google (Gemini / Antigravity)
  [/gemini-3|gemini-2\.5-pro|gemini.*pro/i, { in: 1.25, out: 10 }],
  [/gemini.*flash/i, { in: 0.3, out: 2.5 }],
];

/** Estimated $ for a session's token usage, or null when the model is unknown
 *  or unpriced. */
export function estimateCost(s: TokenUsage): number | null {
  if (!s.model) return null;
  const price = PRICING.find(([re]) => re.test(s.model!))?.[1];
  if (!price) return null;
  return (
    (s.input_tokens + s.cache_creation_tokens * 1.25) * (price.in / 1e6) +
    (s.cache_read_tokens * (price.in * 0.1)) / 1e6 +
    s.output_tokens * (price.out / 1e6)
  );
}

/** A session's cost: the CLI's own figure when it reports one, else an
 *  estimate. Returns null when neither is available. */
export function sessionCost(
  s: TokenUsage & { cost?: number | null },
): number | null {
  if (s.cost != null) return s.cost;
  return estimateCost(s);
}

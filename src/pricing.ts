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
  // OpenAI (Codex) — verified against the 2026-07-30 price change (gpt-5.6
  // family: sol $5/$30, terra $2/$12, luna $0.20/$1.20; gpt-5.5 matches sol)
  // on 2026-08-06. Suffix rows go first: a bare gpt-5.6 alias serves sol.
  [/-terra/i, { in: 2, out: 12 }],
  [/-luna/i, { in: 0.2, out: 1.2 }],
  [/gpt-5\.?[56]/i, { in: 5, out: 30 }],
  [/gpt-5/i, { in: 1.25, out: 10 }],
  [/o4|o3|o1/i, { in: 2, out: 8 }],
  [/gpt-4\.1/i, { in: 2, out: 8 }],
  [/gpt-4o/i, { in: 2.5, out: 10 }],
  // Google (Gemini / Antigravity) — verified against ai.google.dev pricing on
  // 2026-08-06 (3.1 pro preview $2/$12, 3.6 flash $1.50/$7.50, flash-lite
  // $0.30/$2.50). Flash rows must precede the pro/family rows: `gemini-3`
  // used to sit first and billed every 3.x flash model at the pro rate.
  [/gemini.*flash-lite/i, { in: 0.3, out: 2.5 }],
  [/gemini-3.*flash/i, { in: 1.5, out: 7.5 }],
  [/gemini.*flash/i, { in: 0.3, out: 2.5 }],
  [/gemini-3/i, { in: 2, out: 12 }],
  [/gemini-2\.5-pro|gemini.*pro/i, { in: 1.25, out: 10 }],
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

/** Subsequence match with a light score: earlier and tighter runs rank higher.
 *  Enough for quick-open and the ⌘N launcher; deliberately not a full
 *  fuzzy-finder. Its own module so both palettes can share it without one
 *  component importing the other. */
export function fuzzy(needle: string, hay: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let score = 0;
  let hi = 0;
  let last = -1;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    score += found === last + 1 ? 0 : found - hi + 1;
    last = found;
    hi = found + 1;
  }
  return score;
}

/** Where the match landed, as merged [start, end) ranges into `hay` — the same
 *  walk as `fuzzy`, kept beside it so what a palette highlights can never
 *  disagree with what it ranked. Null when it doesn't match; empty for an empty
 *  needle. */
export function fuzzyRanges(needle: string, hay: string): [number, number][] | null {
  if (!needle) return [];
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const out: [number, number][] = [];
  let hi = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    const prev = out[out.length - 1];
    if (prev && prev[1] === found) prev[1] = found + ch.length;
    else out.push([found, found + ch.length]);
    hi = found + ch.length;
  }
  return out;
}

// Portions of this file are a hand port of fzf's matching and scoring
// algorithm (algo/algo.go), and are therefore a derivative work of fzf.
//
//   fzf — https://github.com/junegunn/fzf
//
//   The MIT License (MIT)
//
//   Copyright (c) 2013-2026 Junegunn Choi
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
//   THE SOFTWARE.
//
// The notice above travels with this file because that is what the MIT License
// asks: an algorithm is not copyrightable, but a transliteration that keeps the
// constants, the bonus classes and the structure of the original carries its
// expression, and "hand-written in another language" does not make it ours. It
// is also recorded in THIRD-PARTY-NOTICES.md, which is where a reader looks for
// what Canopy ships that it did not write.

/** fzf's matcher, ported by hand — the scoring every palette in the app ranks
 *  by. Same constants as fzf, the same four bonus classes (word boundary,
 *  camelCase, path delimiter, first character), and the same space-separated
 *  AND terms and `'exact` / `^prefix` / `suffix$` / `!negate` operators.
 *
 *  Placement is FuzzyMatchV2's: a Smith-Waterman DP over the window between
 *  the first possible start and the last possible end, so `spot` marks `Spot`
 *  in `src/components/SpotSearch.tsx` rather than the `s…p…o…t` it can reach
 *  first. The greedy V1 pass is kept as the fallback for a window too large to
 *  be worth a matrix, which is what fzf does with a very long line.
 *
 *  The one thing it deliberately does not inherit is **the sign**. fzf scores
 *  higher-is-better. Every ranking surface here sorts ascending — `ranked()`
 *  and `fileRows` in spotSources.ts, Palette, ContextMenu, and SpotSearch's
 *  per-group sort — and three rows are pinned above every match with
 *  hand-written negative scores. So this returns a *cost*: 0 is a perfect
 *  match, larger is worse, never negative. Inverting the convention would have
 *  meant flipping four sorts and retuning those constants to buy nothing.
 *
 *  Hand-ported rather than taken as a dependency (`fzf-for-js`, `nucleo`): one
 *  file, no install, SPEC §5. */

// --- fzf's constants (algo/algo.go), unchanged. ---
const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NON_WORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2;
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1;

/** The most one character can be worth: a first character on a whitespace
 *  boundary, then consecutive characters on the same. Used to turn fzf's score
 *  into a cost that is never negative. */
const IDEAL_FIRST = SCORE_MATCH + BONUS_BOUNDARY_WHITE * BONUS_FIRST_CHAR_MULTIPLIER;
const IDEAL_REST = SCORE_MATCH + BONUS_BOUNDARY_WHITE;
const ideal = (len: number) => (len <= 0 ? 0 : IDEAL_FIRST + IDEAL_REST * (len - 1));

// Ordered: everything above NON_WORD starts a word, which is what bonusFor
// tests. fzf's default delimiter set, so `/` in a path scores as a boundary.
const WHITE = 0;
const NON_WORD = 1;
const DELIMITER = 2;
const LOWER = 3;
const UPPER = 4;
const NUMBER = 5;
const DELIMITERS = "/,:;|";

function classOf(c: string): number {
  if (c >= "a" && c <= "z") return LOWER;
  if (c >= "A" && c <= "Z") return UPPER;
  if (c >= "0" && c <= "9") return NUMBER;
  if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") return WHITE;
  if (DELIMITERS.includes(c)) return DELIMITER;
  if (c > "\x7f") {
    const lo = c.toLowerCase();
    return lo === c.toUpperCase() ? LOWER : c === lo ? LOWER : UPPER;
  }
  return NON_WORD;
}

function bonusFor(prev: number, cur: number): number {
  if (cur > NON_WORD) {
    if (prev === WHITE) return BONUS_BOUNDARY_WHITE;
    if (prev === DELIMITER) return BONUS_BOUNDARY_DELIMITER;
    if (prev === NON_WORD) return BONUS_BOUNDARY;
  }
  if ((prev === LOWER && cur === UPPER) || (prev !== NUMBER && cur === NUMBER)) return BONUS_CAMEL_123;
  if (cur === NON_WORD || cur === DELIMITER) return BONUS_NON_WORD;
  if (cur === WHITE) return BONUS_BOUNDARY_WHITE;
  return 0;
}

/** fzf's calculateScore over `[sidx, eidx)`, which is assumed to contain the
 *  pattern. Character classes come from the original text, the comparison from
 *  its lowercased twin, so `SpotSearch` still reads as camelCase. Appends the
 *  matched offsets to `pos` when one is given — this is the only place match
 *  positions are produced, so a highlight can never disagree with a rank. */
function scoreRegion(
  pat: string,
  hay: string,
  low: string,
  sidx: number,
  eidx: number,
  pos: number[] | null,
): number {
  let pidx = 0;
  let score = 0;
  let inGap = false;
  let consecutive = 0;
  let firstBonus = 0;
  let prev = sidx > 0 ? classOf(hay[sidx - 1]) : WHITE;
  for (let i = sidx; i < eidx; i++) {
    const cur = classOf(hay[i]);
    if (pidx < pat.length && low[i] === pat[pidx]) {
      pos?.push(i);
      score += SCORE_MATCH;
      let bonus = bonusFor(prev, cur);
      if (consecutive === 0) firstBonus = bonus;
      else {
        if (bonus >= BONUS_BOUNDARY && bonus > firstBonus) firstBonus = bonus;
        bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
      }
      score += pidx === 0 ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus;
      inGap = false;
      consecutive++;
      pidx++;
    } else {
      score += inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      inGap = true;
      consecutive = 0;
      firstBonus = 0;
    }
    prev = cur;
  }
  return score;
}

/** fzf's FuzzyMatchV1: walk forward for the earliest end, then back from it for
 *  the latest start, and score only what is between. Greedy, so it can settle
 *  for a worse placement than one exists — kept as the fallback for a window
 *  the matrix below would be wasteful on. */
function greedyTerm(
  pat: string,
  hay: string,
  low: string,
  from: number,
  to: number,
  pos: number[] | null,
): number | null {
  const m = pat.length;
  let sidx = -1;
  let eidx = -1;
  let pidx = 0;
  for (let i = from; i < to; i++) {
    if (low[i] !== pat[pidx]) continue;
    if (sidx < 0) sidx = i;
    if (++pidx === m) {
      eidx = i + 1;
      break;
    }
  }
  if (sidx < 0 || eidx < 0) return null;
  pidx = m - 1;
  for (let i = eidx - 1; i >= sidx; i--) {
    if (low[i] === pat[pidx] && --pidx < 0) {
      sidx = i;
      break;
    }
  }
  return scoreRegion(pat, hay, low, sidx, eidx, pos);
}

// Cells of the DP matrix we are willing to fill for one candidate before
// falling back to the greedy pass. A file path against a typed query is a few
// hundred; this only ever trips on something pathological.
const DP_BUDGET = 1 << 20;

// Grown on demand and reused across candidates — a palette re-ranks its whole
// corpus on every keystroke, and this is the one place that would otherwise
// allocate per row.
let bufB = new Int16Array(0);
let bufH = new Int16Array(0);
let bufC = new Int16Array(0);
let bufR = new Uint8Array(0);

/** fzf's FuzzyMatchV2: the best-scoring placement of `pat` in `hay`, not the
 *  first one found.
 *
 *  `H[i][j]` is the best score for `pat[0..i]` using `hay[0..j]`, either by
 *  matching `pat[i]` at `j` or by extending a gap from `j-1`; `C[i][j]` carries
 *  the length of the consecutive run ending at `j` so a run's first bonus can
 *  be re-read, which is how fzf keeps `Search` in `SpotSearch` worth more than
 *  six scattered letters. `R` is reachability — without it a cell whose score
 *  was clamped to zero reads as a viable prefix and lets `pat[i]` be placed
 *  before `pat[i-1]` was.
 *
 *  The window runs from the first `pat[0]` to the last `pat[M-1]`: no alignment
 *  can start earlier or end later, and starting it there is also why a deep
 *  checkout prefix is never charged to the score. */
function fuzzyTerm(pat: string, hay: string, low: string, pos: number[] | null): number | null {
  const M = pat.length;
  if (M === 0) return 0;
  const N = low.length;
  if (M > N) return null;

  const minIdx = low.indexOf(pat[0]);
  if (minIdx < 0) return null;
  const maxIdx = low.lastIndexOf(pat[M - 1]) + 1;
  const W = maxIdx - minIdx;
  if (W < M) return null;

  // Does it match at all? The matrix's maximum only means something once the
  // pattern is known to fit, and this rejects most of a corpus in one pass.
  for (let i = minIdx, p = 0; ; i++) {
    if (i >= maxIdx) return null;
    if (low[i] === pat[p] && ++p === M) break;
  }
  // Long term or wide window: the greedy pass instead, before the matrix costs
  // more than the answer is worth or a score outgrows the Int16 cells.
  if (M > 512 || M * W > DP_BUDGET) return greedyTerm(pat, hay, low, minIdx, maxIdx, pos);

  if (bufB.length < W) bufB = new Int16Array(W * 2);
  const B = bufB;
  let prev = minIdx > 0 ? classOf(hay[minIdx - 1]) : WHITE;
  for (let j = 0; j < W; j++) {
    const cur = classOf(hay[minIdx + j]);
    B[j] = bonusFor(prev, cur);
    prev = cur;
  }

  const size = M * W;
  if (bufH.length < size) {
    bufH = new Int16Array(size * 2);
    bufC = new Int16Array(size * 2);
    bufR = new Uint8Array(size * 2);
  }
  const H = bufH;
  const C = bufC;
  const R = bufR;
  // Only paid for when someone wants the highlight, i.e. once per visible row.
  const trace = pos ? new Uint8Array(size) : null;

  let maxScore = -1;
  let maxAt = -1;
  for (let i = 0; i < M; i++) {
    const row = i * W;
    const pc = pat[i];
    let inGap = false;
    for (let j = 0; j < W; j++) {
      const at = row + j;
      const left = j > 0 && R[at - 1] ? H[at - 1] : -1;
      const s2: number = left < 0 ? -1 : left + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START);

      let s1 = -1;
      let consecutive = 0;
      if (low[minIdx + j] === pc && (i === 0 || (j > 0 && R[at - W - 1]))) {
        let bonus = B[j];
        if (i === 0) {
          s1 = SCORE_MATCH + bonus * BONUS_FIRST_CHAR_MULTIPLIER;
          consecutive = 1;
        } else {
          consecutive = C[at - W - 1] + 1;
          if (consecutive > 1) {
            const first = B[j - consecutive + 1];
            if (bonus >= BONUS_BOUNDARY && bonus > first) consecutive = 1;
            else bonus = Math.max(bonus, BONUS_CONSECUTIVE, first);
          }
          s1 = H[at - W - 1] + SCORE_MATCH + bonus;
        }
      }

      const match: boolean = s1 >= 0 && s1 >= s2;
      const best = match ? s1 : s2;
      R[at] = best >= 0 ? 1 : 0;
      H[at] = best > 0 ? best : 0;
      C[at] = match ? consecutive : 0;
      if (trace) trace[at] = match ? 1 : 0;
      inGap = !match && best >= 0;
      if (i === M - 1 && match && s1 > maxScore) {
        maxScore = s1;
        maxAt = j;
      }
    }
  }
  if (maxAt < 0) return null;

  if (trace) {
    const found: number[] = [];
    for (let i = M - 1, j = maxAt; i >= 0 && j >= 0; j--) {
      const at = i * W + j;
      if (!trace[at]) continue;
      found.push(minIdx + j);
      i--;
    }
    for (let k = found.length - 1; k >= 0; k--) pos!.push(found[k]);
  }
  return maxScore;
}

type Anchor = "any" | "prefix" | "suffix" | "equal";

/** fzf's ExactMatchNaive — a literal run, scored with the same bonuses, taking
 *  the best-placed occurrence when there are several. */
function exactTerm(
  pat: string,
  hay: string,
  low: string,
  anchor: Anchor,
  pos: number[] | null,
): number | null {
  const m = pat.length;
  const n = low.length;
  if (m === 0) return 0;
  if (m > n) return null;
  const starts: number[] = [];
  if (anchor === "prefix") starts.push(0);
  else if (anchor === "suffix") starts.push(n - m);
  else if (anchor === "equal") {
    if (n !== m) return null;
    starts.push(0);
  } else for (let i = low.indexOf(pat); i >= 0; i = low.indexOf(pat, i + 1)) starts.push(i);

  let best: number | null = null;
  let bestAt = -1;
  for (const at of starts) {
    if (at < 0 || low.slice(at, at + m) !== pat) continue;
    const s = scoreRegion(pat, hay, low, at, at + m, null);
    if (best === null || s > best) {
      best = s;
      bestAt = at;
    }
  }
  if (best === null) return null;
  if (pos) for (let i = 0; i < m; i++) pos.push(bestAt + i);
  return best;
}

interface Term {
  anchor: Anchor | null;
  text: string;
  negated: boolean;
}

/** Split on whitespace, with `\ ` for a literal space — fzf's rule. */
function splitTerms(needle: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < needle.length; i++) {
    const c = needle[i];
    if (c === "\\" && i + 1 < needle.length && /\s/.test(needle[i + 1])) {
      cur += needle[++i];
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** `anchor: null` is a fuzzy term; anything else is a literal one. A negated
 *  term is always literal, as it is in fzf — `!x` excludes rows containing `x`,
 *  not rows that fuzzily resemble it. */
function parse(needle: string): Term[] {
  const out: Term[] = [];
  for (const raw of splitTerms(needle)) {
    let s = raw;
    let negated = false;
    if (s.length > 1 && s.startsWith("!")) {
      negated = true;
      s = s.slice(1);
    }
    let anchor: Anchor | null = negated ? "any" : null;
    if (s.startsWith("'") && s.length > 1) {
      anchor = "any";
      s = s.slice(1);
    } else {
      const pre = s.startsWith("^");
      const suf = s.length > 1 && s.endsWith("$");
      if (pre && suf) {
        anchor = "equal";
        s = s.slice(1, -1);
      } else if (pre) {
        anchor = "prefix";
        s = s.slice(1);
      } else if (suf) {
        anchor = "suffix";
        s = s.slice(0, -1);
      }
    }
    if (!s) continue;
    out.push({ anchor, text: s.toLowerCase(), negated });
  }
  return out;
}

// One-entry memo: `ranked()` parses the same query once per candidate row
// otherwise, and a palette re-runs every source on every keystroke.
let lastNeedle: string | null = null;
let lastTerms: Term[] = [];
function terms(needle: string): Term[] {
  if (needle !== lastNeedle) {
    lastTerms = parse(needle);
    lastNeedle = needle;
  }
  return lastTerms;
}

function run(needle: string, hay: string, pos: number[] | null): number | null {
  const ts = terms(needle);
  if (ts.length === 0) return 0;
  const low = hay.toLowerCase();
  let score = 0;
  let best = 0;
  for (const t of ts) {
    if (t.negated) {
      if (exactTerm(t.text, hay, low, t.anchor ?? "any", null) !== null) return null;
      continue;
    }
    const s =
      t.anchor === null
        ? fuzzyTerm(t.text, hay, low, pos)
        : exactTerm(t.text, hay, low, t.anchor, pos);
    if (s === null) return null;
    score += s;
    best += ideal(t.text.length);
  }
  return Math.max(0, best - score);
}

/** How badly `hay` matches `needle`, or null when it doesn't match at all.
 *  **Lower is better** and it is never negative, so a caller can pin a row
 *  above every match with a negative score of its own. Every term in the needle
 *  must match (fzf's AND), each anywhere in the haystack. */
export function fuzzy(needle: string, hay: string): number | null {
  return run(needle, hay, null);
}

/** A file path's cost: the better of matching its name and matching the whole
 *  path. The name winning is what keeps `fuzzy.ts` above a deep directory that
 *  merely contains those letters; the whole-path score is what makes
 *  `src/fuzzy` a query you can type at all — `/` scores as a boundary, and V1's
 *  backward pass keeps the checkout's own prefix out of the region, so the same
 *  repo ranks the same however deep it is checked out. */
export function pathScore(
  needle: string,
  path: string,
  name = path.slice(path.lastIndexOf("/") + 1),
): number | null {
  const byName = fuzzy(needle, name);
  const byPath = fuzzy(needle, path);
  if (byName === null) return byPath;
  if (byPath === null) return byName;
  return Math.min(byName, byPath);
}

/** Where the match landed, as merged [start, end) ranges into `hay` — the same
 *  walk as `fuzzy`, kept beside it so what a palette highlights can never
 *  disagree with what it ranked. Null when it doesn't match; empty for an empty
 *  needle. */
export function fuzzyRanges(needle: string, hay: string): [number, number][] | null {
  const pos: number[] = [];
  if (run(needle, hay, pos) === null) return null;
  pos.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const p of pos) {
    const prev = out[out.length - 1];
    if (prev && p <= prev[1]) prev[1] = Math.max(prev[1], p + 1);
    else out.push([p, p + 1]);
  }
  return out;
}

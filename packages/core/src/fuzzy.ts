// PostgREST's "Perhaps you meant ..." hints come from a fuzzy set (the `fuzzyset` Haskell package, a
// port of fuzzyset.js): candidates are found by the character n-grams they share with what was asked,
// scored by cosine similarity, then re-scored by edit distance, and the best one is suggested if it
// scores at least `minScore` (0.75 for a name, 0.33 for a parameter list). This is that, with the
// package's defaults (n-grams of 3, then of 2, version 0.2.4).

const GRAM_UPPER = 3;
const GRAM_LOWER = 2;

/** Lowercase, and only letters, digits, spaces and commas: what the package compares. */
const normalized = (s: string): string => [...s.toLowerCase()].filter((c) => /[\p{L}\p{N}\s,]/u.test(c)).join("");

const grams = (value: string, size: number): Map<string, number> => {
  let padded = `-${normalized(value)}-`;
  while (padded.length < size) padded += "-";
  const out = new Map<string, number>();
  for (let i = 0; i + size <= padded.length; i++) {
    const g = padded.slice(i, i + size);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
};

const norm = (v: Map<string, number>): number => Math.sqrt([...v.values()].reduce((a, n) => a + n * n, 0));

const distance = (a: string, b: string): number => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/** The candidate PostgREST would suggest for `value`, if any. */
export const fuzzyGetOne = (candidates: ReadonlyArray<string>, value: string, minScore: number): string | undefined => {
  const unique = [...new Set(candidates)];
  const exact = unique.find((c) => c.toLowerCase() === value.toLowerCase());
  if (exact !== undefined) return exact;
  for (let size = GRAM_UPPER; size >= GRAM_LOWER; size--) {
    const want = grams(value, size);
    const wantNorm = norm(want);
    const scored: Array<{ c: string; score: number }> = [];
    for (const c of unique) {
      const have = grams(c, size);
      let dot = 0;
      for (const [g, n] of want) dot += n * (have.get(g) ?? 0);
      if (dot > 0) scored.push({ c, score: dot / (wantNorm * norm(have)) });
    }
    if (scored.length === 0) continue;
    const best = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      // re-scored on the strings as given: what PostgREST's hints show it does
      .map(({ c }) => ({ c, score: distance(c.toLowerCase(), value.toLowerCase()) }))
      .sort((a, b) => b.score - a.score)
      .filter((r) => r.score >= minScore);
    // a size whose candidates all score too low gives way to the next one (`find (not . null)`)
    if (best.length > 0) return best[0]!.c;
  }
  return undefined;
};

/** Edit distance between two strings. */
export const levenshtein = (a: string, b: string): number => {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
};

import type { FeedNewsItem } from "../ports/event-feed.port";

// One story is one event, however many outlets ran it.
//
// A live check against the real feed made the need obvious: a single TCS announcement came
// back as four separate items — ET Now, LatestLY, scanx.trade and marketscreener each
// carrying a near-identical headline — and RELIANCE's Jio anniversary arrived in English
// and Marathi. Recorded as-is that is four "events" for one fact, which both floods the
// activity feed and quadruples the burst count that decides news severity. Syndication
// would have been indistinguishable from a genuine wave of coverage.
//
// The clustering is deliberately dumb and deterministic: overlap of significant words. It
// is not trying to understand the headlines, only to notice that two of them are the same
// sentence. Translations into another script share no tokens and are not collapsed — a
// real limit, stated here rather than papered over, and the smaller of the two errors:
// showing one extra row beats silently dropping a genuinely different story.

/** Jaccard overlap above which two headlines are treated as the same story. */
export const NEWS_SIMILARITY_THRESHOLD = 0.6;

// Words that carry no identity. Without this, "TCS to invest in X" and "TCS to invest in
// Y" share enough filler to look like one story. Kept as a scannable block rather than one
// word per line, for the same reason SYMBOL_UNIVERSE is: this is a list to read across,
// and reflowed it becomes fifty lines of noise.
// prettier-ignore
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from",
  "by", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these",
  "those", "after", "before", "up", "down", "over", "under", "into", "out", "about", "will",
  "has", "have", "had", "not", "no", "new", "says", "said", "amid", "vs",
]);

/**
 * Significant lowercase word tokens in a headline. Numbers are kept — "70,000 crore" is
 * one of the most identifying things a market headline can contain — with digit grouping
 * removed first, so an outlet writing "70,000" and one writing "70000" produce the same
 * token instead of "70"/"000" and "70000".
 */
export function storyTokens(headline: string): Set<string> {
  const tokens = headline
    .toLowerCase()
    .replace(/[‘’“”']/g, "")
    .replace(/(\d),(?=\d)/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity of two token sets: shared tokens over total distinct tokens. */
export function headlineSimilarity(a: string, b: string): number {
  const left = storyTokens(a);
  const right = storyTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Keeps one item per story cluster: the earliest-published, which is the outlet that broke
 * it rather than whichever syndication happened to be listed first.
 */
export function collapseSyndicatedHeadlines(items: FeedNewsItem[]): FeedNewsItem[] {
  const kept: FeedNewsItem[] = [];

  for (const item of [...items].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const duplicate = kept.some((k) => headlineSimilarity(k.headline, item.headline) >= NEWS_SIMILARITY_THRESHOLD);
    if (!duplicate) kept.push(item);
  }

  return kept;
}

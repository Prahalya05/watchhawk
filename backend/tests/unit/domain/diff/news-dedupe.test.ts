import { describe, expect, it } from "vitest";
import { collapseSyndicatedHeadlines, headlineSimilarity, storyTokens } from "../../../../src/domain/diff/news-dedupe";
import type { FeedNewsItem } from "../../../../src/domain/ports/event-feed.port";

// The headlines here are real ones the live feed returned during development, kept
// verbatim. Synthetic examples would have been easy to make the clustering pass; these are
// what it actually has to handle.

const BASE = Date.parse("2026-09-05T11:00:00.000Z");

function item(headline: string, minutesAfterBase: number, publisher = "outlet"): FeedNewsItem {
  return {
    kind: "NEWS",
    symbol: "TCS",
    externalId: `gnews:${headline.slice(0, 12)}`,
    source: "GOOGLE_NEWS",
    occurredAt: new Date(BASE + minutesAfterBase * 60_000),
    headline,
    publisher,
    url: "https://example.test/a",
  };
}

describe("storyTokens", () => {
  it("drops filler words that carry no identity", () => {
    expect([...storyTokens("TCS to invest in the new campus")]).toEqual(["tcs", "invest", "campus"]);
  });

  it("keeps figures, which are the most identifying thing in a market headline", () => {
    expect(storyTokens("TCS to invest Rs 70,000 crore").has("70000")).toBe(true);
    expect(storyTokens("TCS to invest Rs 70,000 crore").has("crore")).toBe(true);
  });

  it("normalises digit grouping so two outlets' formatting produces the same token", () => {
    expect(storyTokens("invest 70,000 crore").has("70000")).toBe(true);
    expect(storyTokens("invest 70000 crore").has("70000")).toBe(true);
  });
});

describe("headlineSimilarity", () => {
  it("scores two near-identical syndications as the same story", () => {
    const a = "TCS HyperVault to invest up to Rs 70,000 crore for 1GW AI campus in Telangana";
    const b = "TCS' HyperVault to invest up to Rs 70,000 crore for 1 GW AI campus in Telangana";
    expect(headlineSimilarity(a, b)).toBeGreaterThan(0.6);
  });

  it("keeps two genuinely different stories about the same company apart", () => {
    const a = "HDFC Bank's next CEO: 3 big tests to win back investors";
    const b = "Markets Rally, But HDFC Bank Ltd. Sinks to 52-Week Low";
    expect(headlineSimilarity(a, b)).toBeLessThan(0.6);
  });

  it("is not fooled by shared filler into merging unrelated headlines", () => {
    const a = "TCS to invest in the new data centre";
    const b = "TCS to invest in the new hiring drive";
    expect(headlineSimilarity(a, b)).toBeLessThan(0.6);
  });
});

describe("collapseSyndicatedHeadlines", () => {
  it("keeps one row per story and prefers the outlet that published first", () => {
    const items = [
      item("TCS' HyperVault to invest up to Rs 70,000 crore for 1 GW AI campus in Telangana", 30, "ET Now"),
      item("TCS HyperVault to invest up to Rs 70,000 crore for 1GW AI campus in Telangana", 5, "scanx.trade"),
    ];

    const collapsed = collapseSyndicatedHeadlines(items);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].publisher).toBe("scanx.trade");
  });

  it("leaves distinct stories about the same symbol alone", () => {
    const items = [
      item("HDFC Bank's next CEO: 3 big tests to win back investors", 0),
      item("Markets Rally, But HDFC Bank Ltd. Sinks to 52-Week Low", 10),
    ];

    // Collapsing these would swallow one of two genuinely different things the user needs
    // to see — the failure mode that matters more than an extra row.
    expect(collapseSyndicatedHeadlines(items)).toHaveLength(2);
  });

  it("returns an empty list unchanged", () => {
    expect(collapseSyndicatedHeadlines([])).toEqual([]);
  });
});

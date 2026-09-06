import { describe, expect, it } from "vitest";
import { scoreCorporateAction, scoreNews, scoreRatingChange } from "../../../../src/domain/diff/feed-severity";
import { MIN_EXPECTED_NEWS_PER_WINDOW } from "../../../../src/domain/diff/scoring";
import type { FeedCorporateAction, FeedNewsItem, FeedRatingChange } from "../../../../src/domain/ports/event-feed.port";

// Feed events are scored once, at ingestion, and the badge a user sees is whatever this
// decided months ago. There is no second pass to catch a mistake, and a wrong severity
// still renders as a perfectly plausible badge — the same reason the rest of the scoring
// layer is tested this closely.

const NOW = new Date("2026-09-06T10:00:00.000Z");

function newsItem(overrides: Partial<FeedNewsItem> = {}): FeedNewsItem {
  return {
    kind: "NEWS",
    symbol: "RELIANCE",
    externalId: "gnews:abc",
    source: "GOOGLE_NEWS",
    occurredAt: NOW,
    headline: "Reliance Industries wins order",
    publisher: "Reuters",
    url: "https://example.test/a",
    ...overrides,
  };
}

function dividend(amount: number): FeedCorporateAction {
  return {
    kind: "CORPORATE_ACTION",
    action: "DIVIDEND",
    symbol: "TCS",
    externalId: "yahoo:div:1",
    source: "YAHOO_CORPORATE_ACTIONS",
    occurredAt: NOW,
    amount,
  };
}

function rating(fromGrade: string, toGrade: string, action: FeedRatingChange["action"]): FeedRatingChange {
  return {
    kind: "RATING_CHANGE",
    symbol: "INFY",
    externalId: "x:1",
    source: "TEST_FEED",
    occurredAt: NOW,
    firm: "Some Broker",
    fromGrade,
    toGrade,
    action,
  };
}

describe("scoreNews", () => {
  it("scores against the symbol's own normal, not an absolute count", () => {
    // The same three stories: routine for a symbol that always draws three, a burst for
    // one that normally draws one. An absolute ladder could not tell these apart, and
    // would have pinned every heavily-covered mega-cap at the top permanently.
    const busy = scoreNews(newsItem(), { burstCount: 3, expectedBurstCount: 3 });
    const quiet = scoreNews(newsItem(), { burstCount: 3, expectedBurstCount: 1 });

    expect(busy.severity).toBe("MINOR");
    expect(quiet.severity).toBe("CRITICAL");
  });

  it("falls back to the floor when there is no measured baseline, and says so", () => {
    const verdict = scoreNews(newsItem(), { burstCount: 2, expectedBurstCount: null });

    expect(verdict.basis.usedBaselineFloor).toBe(true);
    expect(verdict.basis.comparedAgainst).toBe(MIN_EXPECTED_NEWS_PER_WINDOW);
    expect(verdict.basis.expectedBurstCount).toBeNull();
    expect(verdict.severity).toBe("NOTABLE");
  });

  it("will not claim CRITICAL for a symbol whose normal it does not yet know", () => {
    // Straight from a live first pass: HDFCBANK's eight stories in six hours are its
    // ordinary weekday coverage, and with no baseline yet the raw ratio made seven of them
    // CRITICAL. CRITICAL has to mean "unusual for this symbol", so it is withheld until
    // there is enough history to say what usual is.
    const coldStart = scoreNews(newsItem(), { burstCount: 8, expectedBurstCount: null });

    expect(coldStart.severity).toBe("NOTABLE");
    expect(coldStart.basis.cappedForMissingBaseline).toBe(true);

    // The same eight against a known-quiet symbol is a genuine burst, and still CRITICAL.
    const measured = scoreNews(newsItem(), { burstCount: 8, expectedBurstCount: 1 });
    expect(measured.severity).toBe("CRITICAL");
    expect(measured.basis.cappedForMissingBaseline).toBe(false);
  });

  it("does not flag the cap when the score was below it anyway", () => {
    const verdict = scoreNews(newsItem(), { burstCount: 1, expectedBurstCount: null });
    expect(verdict.severity).toBe("MINOR");
    expect(verdict.basis.cappedForMissingBaseline).toBe(false);
  });

  it("does not let a near-zero baseline rate a single headline as critical", () => {
    // Without the floor, 1 ÷ 0.05 is a ratio of 20 and every first headline in a quiet
    // week would be CRITICAL — the news equivalent of dividing by a zero stdev.
    const verdict = scoreNews(newsItem(), { burstCount: 1, expectedBurstCount: 0.05 });

    expect(verdict.severity).toBe("MINOR");
    expect(verdict.basis.usedBaselineFloor).toBe(true);
  });

  it("records that severity came from volume rather than from reading the headline", () => {
    const verdict = scoreNews(newsItem(), { burstCount: 1, expectedBurstCount: 1 });
    expect(String(verdict.basis.scoredBy)).toMatch(/not content/);
  });
});

describe("scoreCorporateAction", () => {
  it("rates a dividend by its yield against the current price", () => {
    expect(scoreCorporateAction(dividend(100), { referencePrice: 2000 }).severity).toBe("CRITICAL"); // 5%
    expect(scoreCorporateAction(dividend(30), { referencePrice: 2000 }).severity).toBe("NOTABLE"); // 1.5%
    expect(scoreCorporateAction(dividend(10), { referencePrice: 2000 }).severity).toBe("MINOR"); // 0.5%
    expect(scoreCorporateAction(dividend(1), { referencePrice: 2000 }).severity).toBe("NONE"); // 0.05%
  });

  it("reports a dividend without inventing a yield when no price is known", () => {
    const verdict = scoreCorporateAction(dividend(30), { referencePrice: null });

    expect(verdict.severity).toBe("MINOR");
    expect(verdict.basis.yield).toBeNull();
    expect(String(verdict.basis.note)).toMatch(/no reference price/);
  });

  it("treats a split as the loudest corporate action regardless of ratio", () => {
    const split: FeedCorporateAction = {
      kind: "CORPORATE_ACTION",
      action: "SPLIT",
      symbol: "RELIANCE",
      externalId: "yahoo:split:1",
      source: "YAHOO_CORPORATE_ACTIONS",
      occurredAt: NOW,
      splitRatio: "2:1",
      splitFactor: 2,
    };

    // A split restates every share count and price the user last looked at, so there is
    // nothing to grade it against — 2:1 and 5:1 invalidate the remembered number equally.
    expect(scoreCorporateAction(split, { referencePrice: 1322 }).severity).toBe("CRITICAL");
  });
});

describe("scoreRatingChange", () => {
  it("scores by how far the grade moved on the ladder", () => {
    expect(scoreRatingChange(rating("Hold", "Outperform", "UPGRADE")).severity).toBe("MINOR");
    expect(scoreRatingChange(rating("Hold", "Buy", "UPGRADE")).severity).toBe("NOTABLE");
    expect(scoreRatingChange(rating("Buy", "Underperform", "DOWNGRADE")).severity).toBe("CRITICAL");
  });

  it("records the direction the grade moved", () => {
    expect(scoreRatingChange(rating("Buy", "Hold", "DOWNGRADE")).basis.direction).toBe("DOWN");
    expect(scoreRatingChange(rating("Hold", "Buy", "UPGRADE")).basis.direction).toBe("UP");
  });

  it("normalises the wording analysts actually use", () => {
    // "Strong Buy", "Overweight" and "Equal-Weight" are the same ladder in different
    // houses' vocabulary. Treating them as unknown would drop real moves to MINOR.
    expect(scoreRatingChange(rating("Equal-Weight", "Strong Buy", "UPGRADE")).basis.steps).toBe(2);
    expect(scoreRatingChange(rating("Neutral", "Overweight", "UPGRADE")).basis.steps).toBe(1);
  });

  it("does not guess at a grade the ladder does not recognise", () => {
    // Coercing an unknown grade to the middle would silently score it as if understood.
    const verdict = scoreRatingChange(rating("Tier 1", "Buy", "UPGRADE"));

    expect(verdict.severity).toBe("MINOR");
    expect(verdict.basis.steps).toBeNull();
    expect(String(verdict.basis.note)).toMatch(/not on the known ladder/);
  });

  it("has nothing to measure for an initiation", () => {
    const verdict = scoreRatingChange(rating("", "Buy", "INIT"));
    expect(verdict.severity).toBe("MINOR");
    expect(verdict.basis.steps).toBeNull();
  });
});

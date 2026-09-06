import type { FeedCorporateAction, FeedItem, FeedNewsItem, FeedRatingChange } from "../ports/event-feed.port";
import type { Severity } from "./diff.types";
import {
  DIVIDEND_YIELD_THRESHOLDS,
  MIN_EXPECTED_NEWS_PER_WINDOW,
  NEWS_BURST_RATIO_THRESHOLDS,
  RATING_LADDER,
  RATING_STEP_THRESHOLDS,
  SEVERITY_ORDER,
  SPLIT_SEVERITY,
  severityFromRatio,
} from "./scoring";

// Severity for feed-sourced discrete events, decided once at ingestion.
//
// Same contract as the rest of the scoring layer: the function returns both the verdict
// and the numbers that produced it, and the caller stores those numbers in the event's
// payload. The "why?" panel then renders what actually decided the severity instead of
// re-deriving it later from a rounded figure and disagreeing with the badge.

export interface FeedSeverityVerdict {
  severity: Severity;
  /** Rendered by explain.ts as the measured basis for the verdict. Stored on the event. */
  basis: Record<string, unknown>;
}

export interface NewsScoringContext {
  /** Distinct stories for this symbol inside NEWS_BURST_WINDOW_MS, including this one. */
  burstCount: number;
  /**
   * What this symbol normally draws in a window that long, from its own recent history.
   * Null when there is not enough history to say, in which case the floor stands in and
   * the explanation discloses that the comparison is against the floor rather than a
   * measured baseline.
   */
  expectedBurstCount: number | null;
}

export interface CorporateActionScoringContext {
  /** Latest known price, used to turn a dividend into a yield. Null when unknown. */
  referencePrice: number | null;
}

export function scoreNews(item: FeedNewsItem, context: NewsScoringContext): FeedSeverityVerdict {
  const burstCount = Math.max(1, context.burstCount);
  const measured = context.expectedBurstCount;
  // The floor is what stops a symbol that normally draws nothing from rating its first
  // headline in a week as CRITICAL — the same job MIN_STDEV_RETURN_20D does for the
  // z-score. Whether it engaged is recorded, because it changes what the ratio means.
  const expected = Math.max(measured ?? 0, MIN_EXPECTED_NEWS_PER_WINDOW);
  const ratio = burstCount / expected;
  const unbounded = severityFromRatio(ratio, NEWS_BURST_RATIO_THRESHOLDS);

  // Without a measured baseline the ratio is against the floor, and the floor is not this
  // symbol's normal — it is a placeholder for not knowing it. A live first pass made the
  // consequence concrete: HDFCBANK's eight routine stories in six hours, its ordinary
  // weekday coverage, scored CRITICAL seven times over because nothing yet knew that eight
  // is ordinary for HDFCBANK. CRITICAL has to mean "unusual for this symbol", so until
  // there is enough history to say what usual is, it is not claimed.
  const severity = measured === null ? capSeverity(unbounded, "NOTABLE") : unbounded;

  return {
    severity,
    basis: {
      headline: item.headline,
      publisher: item.publisher,
      url: item.url,
      burstCount,
      expectedBurstCount: measured,
      comparedAgainst: expected,
      usedBaselineFloor: measured === null || measured < MIN_EXPECTED_NEWS_PER_WINDOW,
      cappedForMissingBaseline: measured === null && unbounded !== severity,
      ratio,
      scoredBy: "publication volume against this symbol's own normal, not content",
    },
  };
}

function capSeverity(severity: Severity, ceiling: Severity): Severity {
  return SEVERITY_ORDER[severity] > SEVERITY_ORDER[ceiling] ? ceiling : severity;
}

export function scoreCorporateAction(
  item: FeedCorporateAction,
  context: CorporateActionScoringContext,
): FeedSeverityVerdict {
  if (item.action === "SPLIT") {
    return {
      severity: SPLIT_SEVERITY,
      basis: { action: "SPLIT", splitRatio: item.splitRatio ?? null, splitFactor: item.splitFactor ?? null },
    };
  }

  const amount = item.amount ?? 0;
  const referencePrice = context.referencePrice;
  // With no price to divide by there is no yield, and inventing one would put a made-up
  // number in front of the user. The dividend is still reported — it happened — at the
  // bottom of the ladder, with the missing input named in the payload.
  if (referencePrice === null || !(referencePrice > 0) || !(amount > 0)) {
    return {
      severity: "MINOR",
      basis: { action: "DIVIDEND", amount, referencePrice, yield: null, note: "no reference price available" },
    };
  }

  const dividendYield = amount / referencePrice;
  return {
    severity: severityFromRatio(dividendYield, DIVIDEND_YIELD_THRESHOLDS),
    basis: { action: "DIVIDEND", amount, referencePrice, yield: dividendYield },
  };
}

export function scoreRatingChange(item: FeedRatingChange): FeedSeverityVerdict {
  const from = ratingRank(item.fromGrade);
  const to = ratingRank(item.toGrade);
  // An initiation, a reiteration, or a grade neither side of the ladder recognises has no
  // distance to measure. It is still a real event, reported at the bottom of the ladder.
  if (from === null || to === null || item.action === "INIT" || item.action === "REITERATE") {
    return {
      severity: "MINOR",
      basis: {
        firm: item.firm,
        fromGrade: item.fromGrade,
        toGrade: item.toGrade,
        action: item.action,
        steps: null,
        note: from === null || to === null ? "grade not on the known ladder" : "no prior grade to measure against",
      },
    };
  }

  const steps = Math.abs(to - from);
  return {
    severity: severityFromRatio(steps, RATING_STEP_THRESHOLDS),
    basis: {
      firm: item.firm,
      fromGrade: item.fromGrade,
      toGrade: item.toGrade,
      action: item.action,
      steps,
      direction: to > from ? "UP" : to < from ? "DOWN" : "FLAT",
    },
  };
}

// Grades are matched case- and punctuation-insensitively because analyst wording varies
// ("Strong Buy", "strong-buy", "OUTPERFORM"). Anything unrecognised returns null rather
// than being coerced to the middle of the ladder, which would silently score a grade the
// system does not understand as if it did.
function ratingRank(grade: string): number | null {
  const normalized = grade.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.length === 0) return null;
  if (normalized === "strongbuy") return RATING_LADDER.length - 1;
  if (normalized === "strongsell" || normalized === "underweight") return 0;
  if (normalized === "neutral" || normalized === "equalweight" || normalized === "marketperform") {
    return RATING_LADDER.indexOf("Hold");
  }
  if (normalized === "overweight") return RATING_LADDER.indexOf("Outperform");
  const index = RATING_LADDER.findIndex((g) => g.toLowerCase() === normalized);
  return index === -1 ? null : index;
}

// Single entry point, so the ingestor cannot forget to score a kind it has just added.
export function scoreFeedItem(
  item: FeedItem,
  context: NewsScoringContext & CorporateActionScoringContext,
): FeedSeverityVerdict {
  switch (item.kind) {
    case "NEWS":
      return scoreNews(item, context);
    case "CORPORATE_ACTION":
      return scoreCorporateAction(item, context);
    case "RATING_CHANGE":
      return scoreRatingChange(item);
  }
}

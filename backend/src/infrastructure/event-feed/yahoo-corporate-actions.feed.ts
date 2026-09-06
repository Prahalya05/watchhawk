import type {
  EventFeedProvider,
  FeedCapabilities,
  FeedCorporateAction,
  FeedNewsItem,
  FeedRatingChange,
} from "../../domain/ports/event-feed.port";
import { RequestSlots, fetchText } from "./request-slots";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_GAP_MS = 200;

// How far back to ask. Yahoo returns the whole range's actions in one response, so this is
// one request per symbol regardless of depth; the ingestor's own lookback decides what is
// recent enough to record.
const ACTIONS_RANGE = "2y";

interface YahooEventsResponse {
  chart?: {
    result?: Array<{
      events?: {
        dividends?: Record<string, { amount?: number; date?: number }>;
        splits?: Record<string, { date?: number; numerator?: number; denominator?: number; splitRatio?: string }>;
      };
    }>;
  };
}

// Real NSE dividends and splits, from the same chart endpoint the price provider already
// uses — `?events=div,split` populates a `chart.result[0].events` object that the quote
// path simply never asked for. Verified against live NSE symbols: RELIANCE returns both
// dividends and a 2:1 split, TCS and INFY return dividend series.
//
// It inherits the endpoint's known risk (unofficial, unsupported, can change without
// notice — see docs/scope-and-limitations.md) and, deliberately, its manners: a separate
// slot limiter here rather than sharing the quote path's, so a corporate-action sweep can
// never eat the poll loop's request budget.
//
// It does not serve news or ratings, and says so through `capabilities` rather than
// returning an empty array that would read as "nothing happened".
export class YahooCorporateActionsFeed implements EventFeedProvider {
  readonly name = "YAHOO_CORPORATE_ACTIONS";
  readonly capabilities: FeedCapabilities = { news: false, corporateActions: true, ratingChanges: false };

  private slots = new RequestSlots(MIN_REQUEST_GAP_MS);

  async fetchNews(): Promise<FeedNewsItem[]> {
    return [];
  }

  async fetchRatingChanges(): Promise<FeedRatingChange[]> {
    return [];
  }

  async fetchCorporateActions(symbol: string, since: Date): Promise<FeedCorporateAction[]> {
    await this.slots.reserve();
    const url = `${CHART_URL}/${encodeURIComponent(symbol)}.NS?range=${ACTIONS_RANGE}&interval=1d&events=div%2Csplit`;
    const body = await fetchText(url, REQUEST_TIMEOUT_MS);
    if (body === null) return [];

    let parsed: YahooEventsResponse;
    try {
      parsed = JSON.parse(body) as YahooEventsResponse;
    } catch {
      return [];
    }

    const events = parsed.chart?.result?.[0]?.events;
    if (!events) return [];

    const items: FeedCorporateAction[] = [];
    const sinceMs = since.getTime();

    for (const dividend of Object.values(events.dividends ?? {})) {
      const occurredAt = epochSecondsToDate(dividend?.date);
      if (occurredAt === null || occurredAt.getTime() < sinceMs) continue;
      if (!(typeof dividend.amount === "number" && dividend.amount > 0)) continue;
      items.push({
        kind: "CORPORATE_ACTION",
        action: "DIVIDEND",
        symbol,
        // Yahoo keys these by the ex-date epoch, which is stable across polls — that is
        // what makes deduplication work without storing the whole item to compare.
        externalId: `yahoo:div:${dividend.date}`,
        source: this.name,
        occurredAt,
        amount: dividend.amount,
      });
    }

    for (const split of Object.values(events.splits ?? {})) {
      const occurredAt = epochSecondsToDate(split?.date);
      if (occurredAt === null || occurredAt.getTime() < sinceMs) continue;
      const numerator = split.numerator;
      const denominator = split.denominator;
      const splitFactor =
        typeof numerator === "number" && typeof denominator === "number" && denominator > 0
          ? numerator / denominator
          : undefined;
      items.push({
        kind: "CORPORATE_ACTION",
        action: "SPLIT",
        symbol,
        externalId: `yahoo:split:${split.date}`,
        source: this.name,
        occurredAt,
        splitRatio: split.splitRatio ?? (splitFactor !== undefined ? `${numerator}:${denominator}` : undefined),
        splitFactor,
      });
    }

    return items;
  }
}

function epochSecondsToDate(seconds: number | undefined): Date | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

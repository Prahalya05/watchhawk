import { prisma } from "../../infrastructure/db/prisma";
import { compositeEventFeed } from "../../infrastructure/event-feed/composite-event-feed";
import { readMarketState } from "../../infrastructure/market-data/read-state";
import { NEWS_BASELINE_WINDOW_MS, NEWS_BURST_WINDOW_MS } from "../../domain/diff/scoring";
import { scoreFeedItem } from "../../domain/diff/feed-severity";
import type { FeedItem } from "../../domain/ports/event-feed.port";
import { getActiveSymbols } from "./subscription-manager";
import { writeDiscreteEvent } from "./market-state-writer";

// Turns real feed items into SymbolEvents.
//
// This is what makes NEWS and CORPORATE_ACTION real rather than demo-only. The event
// model, the severity ladder and the diff path were always real; what was missing was
// anything putting genuine items into them. The admin trigger is unchanged and still
// there — a live demo cannot wait for a dividend — but it is now one source among
// several, and every event records which one it came from so the "why?" panel can say so.

// How far back a poll looks. Deliberately short: this is a "what changed since you last
// looked" product, and the first run for a symbol would otherwise import two years of
// dividends in one pass. Anything older than this is history, not news.
const NEWS_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const CORPORATE_ACTION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const RATING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface EventFeedIngestResult {
  symbolsPolled: number;
  recorded: number;
  duplicates: number;
  /** Real items that scored below the MINOR threshold — a token dividend, a flat rating restatement. */
  belowThreshold: number;
  failed: string[];
  /** Feeds no configured provider can serve. Reported so "none found" is never mistaken for "none happened". */
  unsupported: Array<"NEWS" | "CORPORATE_ACTION" | "RATING_CHANGE">;
}

export async function ingestEventFeeds(now: Date = new Date()): Promise<EventFeedIngestResult> {
  const symbols = await getActiveSymbols();
  const capabilities = compositeEventFeed.capabilities;

  const result: EventFeedIngestResult = {
    symbolsPolled: symbols.length,
    recorded: 0,
    duplicates: 0,
    belowThreshold: 0,
    failed: [],
    unsupported: [
      ...(capabilities.news ? [] : (["NEWS"] as const)),
      ...(capabilities.corporateActions ? [] : (["CORPORATE_ACTION"] as const)),
      ...(capabilities.ratingChanges ? [] : (["RATING_CHANGE"] as const)),
    ],
  };

  for (const symbol of symbols) {
    try {
      const items = await collectItems(symbol, now, capabilities);
      if (items.length === 0) continue;

      // One state read per symbol, not per item: the reference price only turns a dividend
      // into a yield, and every item for this symbol is scored against the same price.
      const referencePrice = (await readMarketState(symbol))?.price ?? null;
      const burstAt = await buildNewsBurstIndex(symbol, items, now);
      const expectedBurstCount = await expectedNewsPerWindow(symbol, now);

      // Oldest first, so a burst is written in the order it happened and the activity feed
      // reads chronologically rather than in whatever order the vendor returned.
      for (const item of [...items].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
        const verdict = scoreFeedItem(item, {
          burstCount: burstAt(item.occurredAt),
          expectedBurstCount,
          referencePrice,
        });
        // Below the MINOR threshold means the item is real but too small to be worth
        // anyone's attention — a token dividend, a rating restated at the same grade.
        // Dropped rather than recorded at NONE: an event row that never earns a badge is
        // still a row every future diff query has to read past.
        if (verdict.severity === "NONE") {
          result.belowThreshold++;
          continue;
        }

        const written = await writeDiscreteEvent(
          symbol,
          item.kind === "NEWS" ? "NEWS" : item.kind === "CORPORATE_ACTION" ? "CORPORATE_ACTION" : "RATING_CHANGE",
          verdict.severity,
          verdict.basis,
          { source: item.source, externalId: item.externalId, eventTime: item.occurredAt },
        );
        if (written) result.recorded++;
        else result.duplicates++;
      }
    } catch (err) {
      // Per-symbol, like every other provider path here: one symbol the vendor refuses to
      // serve must not stop the rest of the watchlist from getting its events.
      console.warn(`[event-feed] ${symbol} failed:`, (err as Error).message);
      result.failed.push(symbol);
    }
  }

  return result;
}

async function collectItems(
  symbol: string,
  now: Date,
  capabilities: { news: boolean; corporateActions: boolean; ratingChanges: boolean },
): Promise<FeedItem[]> {
  const since = (ms: number) => new Date(now.getTime() - ms);

  // Concurrent because the feeds share nothing and neither gates the other — awaiting them
  // in sequence would just add the slower one's latency to every symbol. Each provider
  // paces its own requests (see RequestSlots), so this does not raise the outbound rate.
  const [news, corporateActions, ratingChanges] = await Promise.all([
    capabilities.news ? compositeEventFeed.fetchNews(symbol, since(NEWS_LOOKBACK_MS)) : [],
    capabilities.corporateActions
      ? compositeEventFeed.fetchCorporateActions(symbol, since(CORPORATE_ACTION_LOOKBACK_MS))
      : [],
    capabilities.ratingChanges ? compositeEventFeed.fetchRatingChanges(symbol, since(RATING_LOOKBACK_MS)) : [],
  ]);

  return [...news, ...corporateActions, ...ratingChanges];
}

// Builds "how much was being published around the time this story ran", as a function of
// an instant rather than a single number for the whole pass.
//
// The single-number version was wrong in a way a live run made obvious. A first pass
// imports a day and a half of backlog at once, and scoring every one of those items
// against the burst measured *now* rated a story from thirty hours ago by how busy the
// last six hours happen to be. Each item is judged against its own six hours instead,
// which is what the severity claims to mean.
//
// Already-recorded events count too: the second hour of a running story is not the first
// headline of a quiet day. Only real reporting counts — an admin-triggered demo headline
// is not evidence of press coverage, and letting it inflate the count would make a demo
// silently re-score the genuine news around it.
async function buildNewsBurstIndex(symbol: string, items: FeedItem[], now: Date): Promise<(at: Date) => number> {
  const incoming = items.filter((i) => i.kind === "NEWS");
  if (incoming.length === 0) return () => 0;

  const earliest = Math.min(...incoming.map((i) => i.occurredAt.getTime()));
  const recorded = await prisma.symbolEvent.findMany({
    where: {
      symbol,
      eventType: "NEWS",
      eventTime: { gte: new Date(earliest - NEWS_BURST_WINDOW_MS), lte: now },
      source: { not: "ADMIN_DEMO" },
    },
    select: { eventTime: true, externalId: true },
  });

  // A re-polled headline is already in `recorded`, so counting it again from `incoming`
  // would make severity climb every cycle for a story that has not been repeated at all.
  const knownIds = new Set(recorded.map((r) => r.externalId));
  const times = [
    ...recorded.map((r) => r.eventTime.getTime()),
    ...incoming.filter((i) => !knownIds.has(i.externalId)).map((i) => i.occurredAt.getTime()),
  ];

  return (at: Date) => {
    const end = at.getTime();
    const start = end - NEWS_BURST_WINDOW_MS;
    return times.filter((t) => t > start && t <= end).length;
  };
}

// What this symbol normally draws in one burst window, from its own last week of recorded
// news. This is the news equivalent of avgVolume20d, and it exists for the same reason: an
// absolute threshold is not a statement about the symbol. HDFCBANK draws several stories
// on a quiet morning and a mid-cap draws none, so the same raw count means opposite things
// for the two — measuring each against itself is what makes the severity comparable.
//
// Returns null when there is not enough history to claim a normal, which the scorer
// discloses rather than papering over with the floor silently.
async function expectedNewsPerWindow(symbol: string, now: Date): Promise<number | null> {
  const windowStart = new Date(now.getTime() - NEWS_BASELINE_WINDOW_MS);
  const recorded = await prisma.symbolEvent.count({
    where: {
      symbol,
      eventType: "NEWS",
      eventTime: { gte: windowStart },
      // Demo triggers are not press coverage, so they must not raise the bar a real burst
      // has to clear — nor lower it, which is why they are excluded from both sides.
      source: { not: "ADMIN_DEMO" },
    },
  });

  // A symbol only tracked for a few hours has no week to average over. Reporting that
  // honestly is better than dividing a real week's worth of thresholds by a few hours of
  // observation and calling the result a baseline.
  const oldest = await prisma.symbolEvent.findFirst({
    where: { symbol, eventType: "NEWS", source: { not: "ADMIN_DEMO" } },
    orderBy: { eventTime: "asc" },
    select: { eventTime: true },
  });
  if (oldest === null) return null;

  const observedMs = Math.min(now.getTime() - oldest.eventTime.getTime(), NEWS_BASELINE_WINDOW_MS);
  const windows = observedMs / NEWS_BURST_WINDOW_MS;
  if (windows < MIN_BASELINE_WINDOWS) return null;

  return recorded / windows;
}

// Below this the average is dominated by whichever few hours happened to be observed.
// Four windows is a day of coverage, which is the least that can be called a normal.
const MIN_BASELINE_WINDOWS = 4;

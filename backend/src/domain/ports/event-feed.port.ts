// The port behind NEWS / RATING_CHANGE / CORPORATE_ACTION.
//
// These three used to exist only as admin-panel triggers. The event model, the severity
// scoring and the diff path around them were real; the feed was not — which meant the one
// thing a user could not trust was whether the event had happened at all. This port is
// what the ingestion path depends on now, exactly as market-data.port.ts is what the poll
// loop depends on: the rest of the system never sees a vendor's wire format.
//
// The vendor reality behind the implementations (measured, not assumed):
//   - corporate actions: Yahoo's chart endpoint serves real NSE dividends and splits.
//   - news: Google News' RSS search serves real, per-company Indian market coverage.
//   - rating changes: no free source covers NSE. Yahoo's upgradeDowngradeHistory returns
//     972 entries for AAPL and 404 "No fundamentals data found" for RELIANCE.NS and
//     TCS.NS with a valid crumb, so the gap is coverage, not authentication.
//
// That last one is why `capabilities` exists. A provider that cannot serve a feed says
// so, instead of returning an empty array that reads identically to "nothing happened" —
// the ingestor reports an unsupported feed as unsupported, and the admin trigger stays
// the honest, labelled way to produce one.

export interface FeedCapabilities {
  news: boolean;
  corporateActions: boolean;
  ratingChanges: boolean;
}

// Every feed item carries the identity the ingestor deduplicates on. `externalId` must be
// stable for the same real-world item across polls — a feed that renumbers its items on
// every fetch would write the same headline once a cycle, forever.
interface FeedItemBase {
  symbol: string;
  externalId: string;
  source: string;
  occurredAt: Date;
}

export interface FeedNewsItem extends FeedItemBase {
  kind: "NEWS";
  headline: string;
  publisher: string;
  url: string;
}

export interface FeedCorporateAction extends FeedItemBase {
  kind: "CORPORATE_ACTION";
  action: "DIVIDEND" | "SPLIT";
  /** Dividend amount per share, in the symbol's currency. Absent for a split. */
  amount?: number;
  /** e.g. "2:1". Absent for a dividend. */
  splitRatio?: string;
  splitFactor?: number;
}

export interface FeedRatingChange extends FeedItemBase {
  kind: "RATING_CHANGE";
  firm: string;
  fromGrade: string;
  toGrade: string;
  action: "UPGRADE" | "DOWNGRADE" | "INIT" | "REITERATE";
}

export type FeedItem = FeedNewsItem | FeedCorporateAction | FeedRatingChange;

export interface EventFeedProvider {
  readonly name: string;
  readonly capabilities: FeedCapabilities;
  /** Items whose `occurredAt` is at or after `since`. Implementations filter server-side where they can. */
  fetchNews(symbol: string, since: Date): Promise<FeedNewsItem[]>;
  fetchCorporateActions(symbol: string, since: Date): Promise<FeedCorporateAction[]>;
  fetchRatingChanges(symbol: string, since: Date): Promise<FeedRatingChange[]>;
}

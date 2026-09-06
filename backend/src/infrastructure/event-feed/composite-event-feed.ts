import type {
  EventFeedProvider,
  FeedCapabilities,
  FeedCorporateAction,
  FeedNewsItem,
  FeedRatingChange,
} from "../../domain/ports/event-feed.port";
import { GoogleNewsFeed } from "./google-news.feed";
import { YahooCorporateActionsFeed } from "./yahoo-corporate-actions.feed";

// One provider per feed, composed into the single EventFeedProvider the ingestor talks to.
//
// The composite's capabilities are the union of its members', which is what makes an
// unsupported feed visible instead of silent: no member claims `ratingChanges`, so
// `capabilities.ratingChanges` is false and the ingestor reports RATING_CHANGE as having
// no source rather than reporting zero rating changes. Adding a provider that does serve
// NSE ratings is a one-line change here and nothing anywhere else.
//
// A member that throws is contained: an outage at one vendor must not stop the other
// feed's events from being recorded.
export class CompositeEventFeed implements EventFeedProvider {
  readonly name = "COMPOSITE";

  private readonly members: EventFeedProvider[] = [new GoogleNewsFeed(), new YahooCorporateActionsFeed()];

  get capabilities(): FeedCapabilities {
    return {
      news: this.members.some((m) => m.capabilities.news),
      corporateActions: this.members.some((m) => m.capabilities.corporateActions),
      ratingChanges: this.members.some((m) => m.capabilities.ratingChanges),
    };
  }

  async fetchNews(symbol: string, since: Date): Promise<FeedNewsItem[]> {
    return this.gather(
      (m) => m.capabilities.news,
      (m) => m.fetchNews(symbol, since),
    );
  }

  async fetchCorporateActions(symbol: string, since: Date): Promise<FeedCorporateAction[]> {
    return this.gather(
      (m) => m.capabilities.corporateActions,
      (m) => m.fetchCorporateActions(symbol, since),
    );
  }

  async fetchRatingChanges(symbol: string, since: Date): Promise<FeedRatingChange[]> {
    return this.gather(
      (m) => m.capabilities.ratingChanges,
      (m) => m.fetchRatingChanges(symbol, since),
    );
  }

  private async gather<T>(
    supports: (member: EventFeedProvider) => boolean,
    fetchFrom: (member: EventFeedProvider) => Promise<T[]>,
  ): Promise<T[]> {
    const results = await Promise.all(
      this.members.filter(supports).map(async (member) => {
        try {
          return await fetchFrom(member);
        } catch (err) {
          console.warn(`[event-feed] ${member.name} unavailable this cycle:`, (err as Error).message);
          return [];
        }
      }),
    );
    return results.flat();
  }
}

export const compositeEventFeed = new CompositeEventFeed();

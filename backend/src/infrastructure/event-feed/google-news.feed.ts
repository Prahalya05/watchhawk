import type {
  EventFeedProvider,
  FeedCapabilities,
  FeedCorporateAction,
  FeedNewsItem,
  FeedRatingChange,
} from "../../domain/ports/event-feed.port";
import { SYMBOL_MAP } from "../../domain/market/symbol-universe";
import { collapseSyndicatedHeadlines } from "../../domain/diff/news-dedupe";
import { RequestSlots, fetchText } from "./request-slots";

const SEARCH_URL = "https://news.google.com/rss/search";
const REQUEST_TIMEOUT_MS = 12_000;
const MIN_REQUEST_GAP_MS = 400;

// Cap per symbol per poll, applied to distinct *stories* rather than articles. A burst of
// coverage is real, but writing forty rows for one symbol in one cycle is how an alerting
// product becomes noise — and the burst count that scores severity is already the thing
// that represents "there is a lot of this".
const MAX_ITEMS_PER_SYMBOL = 6;

// Real per-company Indian market coverage, from Google News' RSS search.
//
// This exists because Yahoo's own news endpoint does not work for this: `v1/finance/search`
// answers HTTP 200 for `q=RELIANCE.NS` and returns generic US wire stories (Rocket Lab,
// the US Open) with `relatedTickers` naming other companies entirely, and the NSE RSS
// headline feed returns a well-formed feed containing zero items. Neither is a feed that
// happens to be empty; both are feeds that ignore the ticker, which is worse — it would
// have attributed unrelated headlines to a user's watchlist.
//
// Google News' search RSS does honour the query, and it is region-scoped to India, so the
// publishers are the ones an NSE watchlist should be reading. Its limits are stated
// rather than hidden: it is an undocumented feed with no published quota (hence the slot
// limiter), it returns headlines rather than article bodies, and matching is by company
// name, which is why every result is filtered again below before it is believed.
export class GoogleNewsFeed implements EventFeedProvider {
  readonly name = "GOOGLE_NEWS";
  readonly capabilities: FeedCapabilities = { news: true, corporateActions: false, ratingChanges: false };

  private slots = new RequestSlots(MIN_REQUEST_GAP_MS);

  async fetchCorporateActions(): Promise<FeedCorporateAction[]> {
    return [];
  }

  async fetchRatingChanges(): Promise<FeedRatingChange[]> {
    return [];
  }

  async fetchNews(symbol: string, since: Date): Promise<FeedNewsItem[]> {
    const def = SYMBOL_MAP.get(symbol);
    if (!def) return [];

    await this.slots.reserve();
    const lookbackDays = Math.max(1, Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)));
    const query = `"${def.name}" stock when:${lookbackDays}d`;
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

    const body = await fetchText(url, REQUEST_TIMEOUT_MS);
    if (body === null) return [];

    return parseGoogleNewsRss(body, { symbol, name: def.name, since, source: this.name });
  }
}

// Parsing is separated from fetching so it can be tested against a fixture rather than
// against the live feed. Everything that decides what becomes an event — the date filter,
// the publisher split, the relevance gate, the syndication collapse — happens here, and
// none of it needs a network call to verify.
export function parseGoogleNewsRss(
  xml: string,
  context: { symbol: string; name: string; since: Date; source: string },
): FeedNewsItem[] {
  const { symbol, name, since, source } = context;
  const items: FeedNewsItem[] = [];
  const sinceMs = since.getTime();

  for (const raw of extractItems(xml)) {
    const publishedAt = Date.parse(tag(raw, "pubDate") ?? "");
    if (!Number.isFinite(publishedAt) || publishedAt < sinceMs) continue;

    const rawTitle = decodeEntities(tag(raw, "title") ?? "");
    if (rawTitle.length === 0) continue;

    const publisher = decodeEntities(tag(raw, "source") ?? "").trim();
    // Google appends " - Publisher" to every title. Stripping it keeps the stored
    // headline the headline, with the publisher in its own field where the UI can
    // attribute it properly.
    const headline =
      publisher.length > 0 ? rawTitle.replace(new RegExp(`\\s*-\\s*${escapeRegExp(publisher)}$`), "") : rawTitle;

    // The relevance gate. A name-scoped search still returns neighbours — a "Reliance
    // Industries" query returned an "Itl Industries" share-price page — and attributing
    // another company's headline to this symbol is precisely the confident-and-wrong
    // failure the rest of this system is built to avoid. A missed headline costs the
    // user nothing they can see; a wrong one costs them their trust in every other row.
    if (!mentionsSymbol(headline, symbol, name)) continue;

    const guid = tag(raw, "guid");
    const link = decodeEntities(tag(raw, "link") ?? "");
    const externalId = guid ? `gnews:${guid.trim()}` : `gnews:${link}`;
    if (externalId === "gnews:") continue;

    items.push({
      kind: "NEWS",
      symbol,
      externalId,
      source,
      occurredAt: new Date(publishedAt),
      headline,
      publisher: publisher.length > 0 ? publisher : "unknown",
      url: link,
    });
  }

  // Collapse first, then cap. One announcement comes back from four outlets at once, so
  // capping the raw list would spend the whole allowance on a single story and drop the
  // genuinely different ones behind it.
  const stories = collapseSyndicatedHeadlines(items);
  stories.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return stories.slice(0, MAX_ITEMS_PER_SYMBOL);
}

// Matched on the ticker as a whole word, or on the full company name. Deliberately strict:
// a first-word match ("Tata") would hand Tata Motors' news to TCS, and a fuzzy match has
// no way to tell a mention from a passing reference. Word boundaries matter for the short
// tickers in the universe — a substring test would find ITC inside "SWITCH".
export function mentionsSymbol(headline: string, symbol: string, name: string): boolean {
  const haystack = headline.toLowerCase();
  if (haystack.includes(name.toLowerCase())) return true;
  return new RegExp(`\\b${escapeRegExp(symbol.toLowerCase())}\\b`).test(haystack);
}

// A deliberately small RSS reader rather than an XML dependency. It handles exactly what
// Google News emits — flat <item> elements with text children, some CDATA-wrapped — and
// nothing else: no namespaces, no nested elements of the same name, no attribute parsing
// beyond ignoring them. That is a real limit, and it is why every field it produces is
// validated by the caller above rather than trusted.
function extractItems(xml: string): string[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
}

function tag(itemXml: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(itemXml);
  if (!match) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(match[1]);
  return (cdata ? cdata[1] : match[1]).trim();
}

function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Ampersand last: decoding it first would turn "&amp;quot;" into a quote character
      // rather than the literal "&quot;" the feed actually meant.
      .replace(/&amp;/g, "&")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

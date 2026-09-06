import { describe, expect, it } from "vitest";
import { mentionsSymbol, parseGoogleNewsRss } from "../../../../src/infrastructure/event-feed/google-news.feed";

// Parsing a vendor feed is a place where being wrong is invisible: a mis-split title still
// looks like a headline, and a headline attributed to the wrong symbol looks exactly like
// a real one. The fixture below is shaped like what Google News actually returns, right
// down to the " - Publisher" suffix and the HTML entities.

const SINCE = new Date("2026-09-04T00:00:00.000Z");

function rss(items: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Google News</title>${items}</channel></rss>`;
}

function feedItem(opts: { title: string; pubDate?: string; guid?: string; source?: string; link?: string }): string {
  return `<item>
    <title>${opts.title}</title>
    <link>${opts.link ?? "https://news.google.com/read/abc"}</link>
    <guid isPermaLink="false">${opts.guid ?? "CBMiabc123"}</guid>
    <pubDate>${opts.pubDate ?? "Fri, 05 Sep 2026 11:35:00 GMT"}</pubDate>
    <source url="https://reuters.com">${opts.source ?? "Reuters"}</source>
  </item>`;
}

function parse(xml: string, symbol = "TCS", name = "Tata Consultancy Services") {
  return parseGoogleNewsRss(xml, { symbol, name, since: SINCE, source: "GOOGLE_NEWS" });
}

describe("parseGoogleNewsRss", () => {
  it("extracts the headline, publisher, timestamp and a stable id", () => {
    const items = parse(rss(feedItem({ title: "TCS wins a large deal - Reuters" })));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "NEWS",
      symbol: "TCS",
      publisher: "Reuters",
      externalId: "gnews:CBMiabc123",
      source: "GOOGLE_NEWS",
    });
    // The publisher suffix is Google's, not the headline's — leaving it in would put the
    // outlet's name inside the quoted text of every single story.
    expect(items[0].headline).toBe("TCS wins a large deal");
    expect(items[0].occurredAt.toISOString()).toBe("2026-09-05T11:35:00.000Z");
  });

  it("decodes HTML entities in the headline", () => {
    const items = parse(rss(feedItem({ title: "TCS &amp; Infosys in &#39;talks&#39; - Reuters" })));
    expect(items[0].headline).toBe("TCS & Infosys in 'talks'");
  });

  it("reads a CDATA-wrapped title", () => {
    const items = parse(rss(feedItem({ title: "<![CDATA[TCS opens campus - Reuters]]>" })));
    expect(items[0].headline).toBe("TCS opens campus");
  });

  it("drops items published before the lookback window", () => {
    const items = parse(rss(feedItem({ title: "TCS old story - Reuters", pubDate: "Mon, 01 Sep 2026 09:00:00 GMT" })));
    expect(items).toHaveLength(0);
  });

  it("drops an item with an unparseable date rather than dating it now", () => {
    const items = parse(rss(feedItem({ title: "TCS story - Reuters", pubDate: "sometime last week" })));
    expect(items).toHaveLength(0);
  });

  it("rejects a headline about a different company that the search happened to return", () => {
    // A real failure from the live feed: a "Reliance Industries" query returned an
    // "Itl Industries" share-price page. Attributing that to RELIANCE would put another
    // company's news on the user's row.
    const items = parseGoogleNewsRss(rss(feedItem({ title: "Itl Industries Ltd Share Price - NDTV Profit" })), {
      symbol: "RELIANCE",
      name: "Reliance Industries",
      since: SINCE,
      source: "GOOGLE_NEWS",
    });
    expect(items).toHaveLength(0);
  });

  it("collapses the same announcement carried by several outlets into one story", () => {
    const items = parse(
      rss(
        feedItem({
          title: "TCS HyperVault to invest up to Rs 70,000 crore for 1GW AI campus in Telangana - ET Now",
          source: "ET Now",
          guid: "one",
          pubDate: "Sat, 05 Sep 2026 11:49:00 GMT",
        }) +
          feedItem({
            title: "TCS' HyperVault to invest up to Rs 70,000 crore for 1 GW AI campus in Telangana - scanx",
            source: "scanx",
            guid: "two",
            pubDate: "Sat, 05 Sep 2026 13:16:00 GMT",
          }),
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0].publisher).toBe("ET Now");
  });

  it("returns the newest story first", () => {
    const items = parse(
      rss(
        feedItem({
          title: "TCS opens a campus - Mint",
          source: "Mint",
          guid: "a",
          pubDate: "Fri, 04 Sep 2026 09:00:00 GMT",
        }) +
          feedItem({
            title: "TCS names a new chief - Reuters",
            guid: "b",
            pubDate: "Sat, 05 Sep 2026 09:00:00 GMT",
          }),
      ),
    );

    expect(items.map((i) => i.headline)).toEqual(["TCS names a new chief", "TCS opens a campus"]);
  });

  it("survives a malformed feed without throwing", () => {
    expect(parse("<rss><channel><item><title>unterminated")).toEqual([]);
    expect(parse("")).toEqual([]);
  });
});

describe("mentionsSymbol", () => {
  it("matches the ticker as a whole word", () => {
    expect(mentionsSymbol("ITC raises prices", "ITC", "ITC Limited")).toBe(true);
  });

  it("does not match a ticker buried inside another word", () => {
    // The reason the test is a word-boundary regex and not includes(): a short ticker like
    // ITC appears inside plenty of ordinary words.
    expect(mentionsSymbol("Company to switch suppliers", "ITC", "ITC Limited")).toBe(false);
  });

  it("matches on the full company name too", () => {
    expect(mentionsSymbol("Tata Consultancy Services wins a deal", "TCS", "Tata Consultancy Services")).toBe(true);
  });

  it("does not match on a shared first word alone", () => {
    // "Tata" would hand Tata Motors' news to TCS and Tata Steel alike.
    expect(mentionsSymbol("Tata Motors reports strong sales", "TCS", "Tata Consultancy Services")).toBe(false);
  });
});
